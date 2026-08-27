'use strict';

/*
 * Web Viewer UA Override
 * ---------------------
 * Obsidian's main process installs a per-partition webRequest hook when the
 * renderer sends the "create-browser-session" IPC message. That hook deletes
 * sec-ch-ua and sec-fetch-dest from every request and, for any URL starting
 * with https://accounts.google.com/, replaces the User-Agent header with the
 * literal string "Chrome". Google rejects that with a 401 "malformed".
 *
 * The hook is installed once per partition and cannot be removed from the
 * renderer, so the fix is to send web views to a partition that has never been
 * initialised and to suppress the IPC that would initialise it.
 *
 * While this plugin is enabled:
 *   1. app.getWebviewPartition() returns a clean partition name.
 *   2. The "create-browser-session" IPC is swallowed for that partition.
 *   3. Every <webview> element gets an explicit Chrome user agent before it
 *      is attached to the DOM.
 *   4. Every <webview> element denies permission requests.
 *   5. A main-process handle on the partition's session is held for as long
 *      as the plugin is loaded, and its storage is flushed to disk.
 *
 * On (5): suppressing the IPC in (2) also means nothing in the main process
 * owns the session any more. Obsidian keeps its own sessions in a module-level
 * map for the lifetime of the app; ours had no owner at all, because the only
 * reference it ever got was a local variable holding an @electron/remote proxy
 * that was released as soon as the function returned. An Electron session with
 * no live reference in the main process is collectable, and its browser context
 * goes with it, which is how a partition that is spelled "persist:" still comes
 * back empty after a restart. Holding the handle keeps the context alive;
 * flushing on a timer, on window close and on unload means an Obsidian that is
 * killed rather than quit (an OS restart, say) still leaves the cookie jar and
 * local storage on disk.
 *
 * On (4), be precise about what is and is not covered. Electron routes media,
 * geolocation, notifications, midiSysex, pointerLock, fullscreen and
 * openExternal through the element's permissionrequest event, and those are
 * denied. Synchronous permission checks that Obsidian would normally catch
 * with session.setPermissionCheckHandler do not reach this event, and a fresh
 * partition has no such handler, so Electron's permissive default applies to
 * them. Installing one over @electron/remote is not safe: the check handler is
 * synchronous in the main process and cannot wait on a renderer round trip,
 * and a session-level request handler would pre-empt the element event that
 * does work reliably.
 *
 * Disabling the plugin restores every patch and sends web views back to the
 * original partition, cookie jar and all. Each restore verifies that the
 * current value is still the wrapper this plugin installed, so unloading in a
 * different order from another plugin that patched the same method will not
 * silently destroy that plugin's patch.
 */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice } = obsidian;

const LOG = '[webview-ua-override]';

// Electron persists a partition to disk only when its name starts with this.
const PERSIST_PREFIX = 'persist:';

// Cheap when there is nothing to write, so it can run often enough to survive
// an ungraceful shutdown without being a nuisance.
const FLUSH_INTERVAL_MS = 60 * 1000;

const DEFAULT_SETTINGS = {
  partitionSuffix: 'clean',
  userAgent: '',
  denyPermissions: true,
};

/** Strip the obsidian/x.y.z and Electron/x.y.z tokens, the same way Obsidian's
 *  main process does for its own browser sessions. */
function deriveUserAgent(ua) {
  return String(ua || '')
    .split(/\s+/)
    .filter(function (tok) { return tok && !/^(obsidian|electron)/i.test(tok); })
    .join(' ')
    .trim();
}

/** Derive our partition from Obsidian's, keeping the persist: prefix at the
 *  front where Electron looks for it. Obsidian's partition already starts with
 *  it, so for every build this has shipped against the result is unchanged:
 *  persist:vault-<id> becomes persist:vault-<id>-clean. The normalisation is
 *  there so that a future Obsidian handing us a bare name cannot silently
 *  downgrade web views to an in-memory session that forgets every login. */
function buildPartition(base, suffix) {
  const raw = String(base || '');
  const body = raw.indexOf(PERSIST_PREFIX) === 0 ? raw.slice(PERSIST_PREFIX.length) : raw;
  return PERSIST_PREFIX + body + '-' + suffix;
}

class WebviewUAOverride extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    // Assigned here rather than in onload so that onunload is safe even if
    // onload throws on its very first await.
    this.restores = [];
    this.patchedWindows = new Map();
    this.session = null;
    this.active = false;
    this.unloaded = false;
  }

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    if (this.unloaded) {
      // Disabled while loadData() was still pending. Installing patches now
      // would strand them, because onunload has already run.
      console.warn(LOG, 'unloaded during startup; not patching.');
      return;
    }

    if (typeof this.app.getWebviewPartition !== 'function') {
      new Notice('Web Viewer UA Override: this Obsidian build has no getWebviewPartition(). Plugin inactive.');
      console.error(LOG, 'app.getWebviewPartition is missing; refusing to patch.');
      return;
    }

    try {
      this.electron = require('electron');
    } catch (err) {
      new Notice('Web Viewer UA Override: could not load electron. Plugin inactive.');
      console.error(LOG, err);
      return;
    }

    this.basePartition = this.app.getWebviewPartition();
    this.partition = buildPartition(this.basePartition, this.settings.partitionSuffix || 'clean');

    this.patchPartition();
    this.patchIpc();
    this.patchAllOpenWindows();
    this.acquireSession();

    if (this.session) {
      // Obsidian clears both of these when the plugin unloads.
      this.registerInterval(window.setInterval(() => this.flushStorage(), FLUSH_INTERVAL_MS));
      this.registerDomEvent(window, 'beforeunload', () => this.flushStorage('window closing'));
    }

    // Popout windows are separate JS realms with their own Document.prototype.
    this.registerEvent(
      this.app.workspace.on('window-open', (workspaceWindow, win) => this.patchDocument(win))
    );
    this.registerEvent(
      this.app.workspace.on('window-close', (workspaceWindow, win) => this.unpatchDocument(win))
    );

    this.addSettingTab(new WebviewUASettingTab(this.app, this));
    this.active = true;

    console.info(
      LOG, 'active.',
      '\n  partition:', this.partition,
      '\n  userAgent:', this.effectiveUserAgent(),
      '\n  session handle:', this.session ? 'held' : 'MISSING (logins may not survive a restart)'
    );

    this.rebuildWebViews();
  }

  onunload() {
    const wasActive = this.active;
    this.active = false;
    this.unloaded = true;

    // Last chance to get anything the open web views wrote onto disk: dropping
    // the handle below may be what takes the session down.
    try { this.flushStorage('plugin unload'); } catch (err) { console.error(LOG, err); }
    this.session = null;

    // Unwinding is unconditional. onload installs patches several statements
    // before it sets this.active, so gating the unwind on that flag would
    // strand the patches whenever onload throws partway through. An empty
    // restores list makes this a no-op on the paths that never patched.
    try {
      const wins = this.patchedWindows ? Array.from(this.patchedWindows.keys()) : [];
      for (const win of wins) this.unpatchDocument(win);
    } catch (err) {
      console.error(LOG, 'failed to unpatch documents', err);
    } finally {
      while (this.restores && this.restores.length) {
        const undo = this.restores.pop();
        try { undo(); } catch (err) { console.error(LOG, 'restore failed', err); }
      }
    }

    if (!wasActive) return;

    console.info(LOG, 'inactive, original behaviour restored.');

    // Rebuild after the patches are gone so views come back on the old partition.
    this.rebuildWebViews();
  }

  effectiveUserAgent() {
    const custom = ((this.settings && this.settings.userAgent) || '').trim();
    return custom || deriveUserAgent(navigator.userAgent);
  }

  /* ---- patch 1: partition ---- */

  patchPartition() {
    const app = this.app;
    const partition = this.partition;
    const hadOwn = Object.prototype.hasOwnProperty.call(app, 'getWebviewPartition');
    const previous = app.getWebviewPartition;

    const wrapper = function () { return partition; };
    app.getWebviewPartition = wrapper;

    this.restores.push(function () {
      if (app.getWebviewPartition !== wrapper) {
        console.warn(LOG, 'getWebviewPartition was re-patched by something else; leaving it alone.');
        return;
      }
      if (hadOwn) app.getWebviewPartition = previous;
      else delete app.getWebviewPartition;
    });
  }

  /* ---- patch 2: swallow create-browser-session for our partition ---- */

  patchIpc() {
    const ipc = this.electron.ipcRenderer;
    if (!ipc || typeof ipc.send !== 'function') {
      console.warn(LOG, 'ipcRenderer.send unavailable; session hooks may still get installed.');
      return;
    }

    const partition = this.partition;
    const basePartition = this.basePartition;
    const hadOwn = Object.prototype.hasOwnProperty.call(ipc, 'send');
    const originalSend = ipc.send;

    const matches = function (arg) {
      if (arg === partition) return true;
      return !!arg && typeof arg === 'object' && arg.partition === partition;
    };

    // Only complain about a miss that looks like it was meant to be ours.
    // Other callers may legitimately create sessions on their own partitions.
    const looksLikeOurs = function (arg) {
      if (typeof arg === 'string') return arg.indexOf(basePartition) !== -1;
      if (arg && typeof arg === 'object' && typeof arg.partition === 'string') {
        return arg.partition.indexOf(basePartition) !== -1;
      }
      return false;
    };

    const wrapper = function (channel, ...args) {
      if (channel === 'create-browser-session') {
        if (args.some(matches)) {
          console.debug(LOG, 'suppressed create-browser-session for', partition);
          return;
        }
        if (args.some(looksLikeOurs)) {
          // Obsidian changed the call shape. The hooks are about to be
          // installed on a partition we did not expect, so make that visible
          // rather than letting sign-ins fail mysteriously.
          console.warn(LOG, 'create-browser-session passed through unrecognised args', args);
        }
      }
      return originalSend.apply(this, [channel].concat(args));
    };

    ipc.send = wrapper;

    this.restores.push(function () {
      if (ipc.send !== wrapper) {
        console.warn(LOG, 'ipcRenderer.send was re-patched by something else; leaving it alone.');
        return;
      }
      if (hadOwn) ipc.send = originalSend;
      else delete ipc.send;
    });
  }

  /* ---- patches 3 and 4: every <webview> gets a UA and a permission guard ---- */

  patchAllOpenWindows() {
    this.patchDocument(window);
    // Popouts that were already open before the plugin loaded never fire
    // window-open, and app.getWebviewPartition is global, so leaving them
    // unpatched would put their web views on the clean partition without a
    // user agent or a permission guard.
    try {
      const floating = this.app.workspace.floatingSplit;
      const children = (floating && floating.children) || [];
      for (const child of children) {
        if (child && child.win) this.patchDocument(child.win);
      }
    } catch (err) {
      console.warn(LOG, 'could not enumerate existing popout windows', err);
    }
  }

  patchDocument(win) {
    if (!win || this.patchedWindows.has(win)) return;

    const proto = win.Document && win.Document.prototype;
    if (!proto || typeof proto.createElement !== 'function') return;

    const originalCreateElement = proto.createElement;
    const plugin = this;

    const wrapper = function (tagName, options) {
      const el = originalCreateElement.call(this, tagName, options);
      try {
        if (typeof tagName === 'string' && tagName.toLowerCase() === 'webview') {
          plugin.prepareWebview(el);
        }
      } catch (err) {
        console.error(LOG, 'failed to prepare webview', err);
      }
      return el;
    };

    proto.createElement = wrapper;

    this.patchedWindows.set(win, function () {
      if (proto.createElement !== wrapper) {
        console.warn(LOG, 'createElement was re-patched by something else; leaving it alone.');
        return;
      }
      proto.createElement = originalCreateElement;
    });
  }

  unpatchDocument(win) {
    const undo = this.patchedWindows.get(win);
    if (!undo) return;
    try { undo(); } catch (err) { console.error(LOG, 'unpatch failed', err); }
    this.patchedWindows.delete(win);
  }

  prepareWebview(el) {
    const ua = this.effectiveUserAgent();

    // Must happen before the element is attached and navigation starts.
    if (ua) el.setAttribute('useragent', ua);

    if (this.settings.denyPermissions) {
      el.addEventListener('permissionrequest', function (evt) {
        console.warn(LOG, 'denied permission request:', evt.permission, el.getAttribute('src') || '');
        try { evt.request.deny(); } catch (err) { console.error(LOG, err); }
      });
    }
  }

  /* ---- patch 5: own the session, and keep its storage on disk ---- */

  acquireSession() {
    const ua = this.effectiveUserAgent();
    try {
      const remote = this.electron.remote || require('@electron/remote');
      // Stored on the plugin on purpose, not in a local. @electron/remote
      // releases the main-process object as soon as the renderer drops its
      // proxy, and an unreferenced session takes its browser context, cookie
      // jar and local storage down with it. Obsidian keeps its own sessions
      // alive the same way; this is that, for the partition we made.
      this.session = remote.session.fromPartition(this.partition);
      if (ua) this.session.setUserAgent(ua);
      console.debug(LOG, 'main-process session handle held for', this.partition);
      return true;
    } catch (err) {
      this.session = null;
      // The per-element useragent attribute still covers the guest page, so
      // sign-ins keep working. Persistence is what suffers, and silently, so
      // say so at a level that shows up in the console by default.
      console.warn(
        LOG,
        'no main-process session handle; web view logins may not survive a restart:',
        err && err.message
      );
      return false;
    }
  }

  /** Ask Chromium to write the partition's cookies and DOM storage out now.
   *  Both are lazy by design, and neither survives Obsidian being killed
   *  instead of quit, which is what an operating system restart does. */
  flushStorage(reason) {
    const ses = this.session;
    if (!ses) return;

    try {
      const cookies = ses.cookies;
      if (cookies && typeof cookies.flushStore === 'function') {
        const done = cookies.flushStore();
        if (done && typeof done.catch === 'function') {
          done.catch(function (err) { console.debug(LOG, 'cookie flush failed', err); });
        }
      }
    } catch (err) {
      console.debug(LOG, 'cookie flush failed', err);
    }

    try {
      if (typeof ses.flushStorageData === 'function') ses.flushStorageData();
    } catch (err) {
      console.debug(LOG, 'DOM storage flush failed', err);
    }

    if (reason) console.debug(LOG, 'flushed web view storage:', reason);
  }

  /* ---- make open tabs pick up the change ---- */

  rebuildWebViews() {
    // Canvas nodes call getWebviewPartition() too, so canvases need the same
    // treatment as web viewer tabs. Only the ones that actually hold a web
    // embed, though: rebuilding a canvas resets its viewport and selection,
    // and a rebuild landing inside Canvas's debounced save window can lose the
    // last edit.
    for (const type of ['webviewer', 'webviewer-history', 'canvas']) {
      let leaves = [];
      try {
        leaves = this.app.workspace.getLeavesOfType(type) || [];
      } catch (err) {
        continue;
      }
      for (const leaf of leaves) {
        if (type === 'canvas' && !this.canvasHasWebNode(leaf)) continue;
        if (typeof leaf.rebuildView === 'function') {
          try { leaf.rebuildView(); } catch (err) { console.error(LOG, 'rebuildView failed', err); }
        }
      }
    }
  }

  canvasHasWebNode(leaf) {
    try {
      const canvas = leaf && leaf.view && leaf.view.canvas;
      const nodes = canvas && canvas.nodes;
      if (!nodes || typeof nodes.forEach !== 'function') return false;
      let found = false;
      nodes.forEach(function (node) {
        if (found || !node) return;
        const data = node.unknownData || node;
        if (data.type === 'link' || typeof node.url === 'string') found = true;
      });
      return found;
    } catch (err) {
      // If we cannot tell, leave the canvas alone rather than risk its state.
      return false;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class WebviewUASettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const containerEl = this.containerEl;
    containerEl.empty();

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Web views run in a separate Electron session that skips Obsidian’s header rewriting. ' +
        'Every setting here applies to web views opened after you close this window. Existing ones keep what they were given.',
    });

    new Setting(containerEl)
      .setName('User agent')
      .setDesc('Leave empty to reuse Obsidian’s own user agent with the obsidian/ and Electron/ tokens removed.')
      .addText((text) =>
        text
          .setPlaceholder(deriveUserAgent(navigator.userAgent))
          .setValue(this.plugin.settings.userAgent)
          .onChange(async (value) => {
            this.plugin.settings.userAgent = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Partition suffix')
      .setDesc(
        'Appended to Obsidian’s partition name to make a fresh one. Changing this starts a brand new cookie jar, ' +
        'which is a quick way to sign out of everything. Restart Obsidian afterwards.'
      )
      .addText((text) =>
        text
          .setPlaceholder('clean')
          .setValue(this.plugin.settings.partitionSuffix)
          .onChange(async (value) => {
            this.plugin.settings.partitionSuffix = value.trim() || 'clean';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Deny permission requests')
      .setDesc(
        'Denies camera, microphone, geolocation, notifications, MIDI, pointer lock, fullscreen and open-external ' +
        'requests from pages in web views. Obsidian normally blocks these at the session level, and that protection ' +
        'does not exist on a clean partition. It does not cover synchronous permission checks, which Electron decides ' +
        'with its own defaults here. Leave this on.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.denyPermissions)
          .onChange(async (value) => {
            this.plugin.settings.denyPermissions = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Save web view storage now')
      .setDesc(
        'Writes web view cookies and local storage to disk immediately. This also happens once a minute, ' +
        'when Obsidian closes, and when the plugin unloads, so you should not need it. It is here for when ' +
        'you are about to restart the machine and want to be sure.'
      )
      .addButton((button) =>
        button
          .setButtonText('Save now')
          .onClick(() => {
            if (!this.plugin.session) {
              new Notice('Web Viewer UA Override: no session handle, nothing to save. See the console.');
              return;
            }
            this.plugin.flushStorage('manual');
            new Notice('Web view storage written to disk.');
          })
      );

    const status = containerEl.createEl('div', { cls: 'setting-item-description' });
    status.createEl('p', { text: 'Active partition: ' + (this.plugin.partition || 'not patched') });
    status.createEl('p', { text: 'Active user agent: ' + this.plugin.effectiveUserAgent() });
    status.createEl('p', {
      text:
        'Session handle: ' +
        (this.plugin.session
          ? 'held. Sign-ins in web views survive restarting Obsidian and the computer.'
          : 'missing. Sign-ins in web views may be lost on restart — check the console for the reason.'),
    });
    status.createEl('p', {
      text:
        'While this plugin is enabled, Obsidian’s built-in EasyList ad blocking does not apply to web views, ' +
        'and web views use a separate cookie jar from the one they use when the plugin is off.',
    });
  }
}

module.exports = WebviewUAOverride;
