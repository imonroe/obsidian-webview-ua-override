# Web Viewer UA Override

An Obsidian plugin that routes web views through a clean Electron session with a real Chrome user agent, so Google sign-in works inside Obsidian.

If you have ever opened Google Docs, Gmail, or anything behind a Google login in Obsidian's **Web Viewer** and been met with a 401 or a "this browser is not supported" wall, this is why, and this fixes it.

---

## The problem

Obsidian's main process rewrites HTTP headers for the Electron session that web views run in. Here is the relevant handler, deminified from `obsidian.asar` (1.13.7):

```js
ipcMain.on("create-browser-session", async (evt, partition, adblock) => {
  let entry = sessions[partition];
  if (!entry) {
    entry = { session: session.fromPartition(partition), adblock: !!adblock };
    sessions[partition] = entry;

    // strip "obsidian/1.13.7" and "Electron/43.3.0" out of the UA
    entry.session.setUserAgent(
      entry.session.getUserAgent().split(" ")
        .filter(tok => !/^(obsidian|electron)/i.test(tok)).join(" ")
    );

    // EasyList + EasyPrivacy ad blocking
    entry.session.webRequest.onBeforeRequest({ urls: ["https://*/*", "http://*/*"] },
      (d, cb) => cb({ cancel: entry.adblock && adblockEngine.matches(d.url) }));

    // the header rewrite
    entry.session.webRequest.onBeforeSendHeaders({ urls: ["https://*/*", "http://*/*"] },
      (d, cb) => {
        let { requestHeaders: h } = d;
        for (let k in h) {
          if (k.toLowerCase() === "sec-fetch-dest" || k.toLowerCase() === "sec-ch-ua")
            delete h[k];
          else if (k.toLowerCase() === "user-agent"
                   && d.url.startsWith("https://accounts.google.com/"))
            h[k] = "Chrome";          // <-- this
        }
        cb({ requestHeaders: h });
      });

    // permission sandbox
    const ALLOWED = ["clipboard-read", "clipboard-sanitized-write"];
    entry.session.setPermissionCheckHandler((wc, perm) => ALLOWED.includes(perm));
    entry.session.setPermissionRequestHandler((wc, perm, cb) => cb(ALLOWED.includes(perm)));
    entry.session.setDevicePermissionHandler(() => false);
  }
});
```

Every request to `accounts.google.com` goes out with a `User-Agent` header of exactly `Chrome`. That is not a user agent string, it is the word "Chrome", and Google rejects it with a 401 "malformed". See [forum thread 117394](https://forum.obsidian.md/t/cant-sign-in-to-google-in-web-viewer-401-malformed/117394) for the original report.

You cannot fix this by setting a user agent on the webview element. The hook rewrites the header after the element's UA has already been applied. You also cannot register your own `onBeforeSendHeaders` to replace it, because a few lines later Obsidian does this to the default session:

```js
let noop = () => false;
r.onBeforeRequest = noop; r.onBeforeSendHeaders = noop; r.onHeadersReceived = noop;
```

It overwrites the registration methods themselves. Plugins are locked out of that pipeline by design.

## The fix

Notice the `if (!entry)` guard. The hooks get installed once per partition, and only when something sends the `create-browser-session` IPC message. A partition that message never names stays clean forever.

So while this plugin is enabled:

1. **`app.getWebviewPartition()` returns a new partition** — `persist:wvua-<appId>-clean` instead of `persist:vault-<appId>`. The `wvua-` is load-bearing; see [below](#why-the-partition-is-not-called-vault-something).
2. **`ipcRenderer.send` swallows `create-browser-session`** for that partition, so the main process never initialises it and the hooks never land.
3. **Every `<webview>` gets an explicit user agent.** `Document.prototype.createElement` is wrapped per window realm, so the `useragent` attribute is set the instant the element exists, before Obsidian assigns `partition` and `src` and before it attaches to the DOM. Electron requires that ordering.
4. **Every `<webview>` denies permission requests**, standing in for the session-level permission sandbox that a fresh partition does not have.
5. **Every `<webview>` is allowed to open popup windows, and Obsidian's own `window.open()` handler is displaced** so those popups are real windows instead of another web view. See [below](#the-other-half-popup-sign-ins).

Both Web Viewer tabs and Canvas web embeds call `getWebviewPartition()`, so both are covered.

## The other half: popup sign-ins

Fixing the header rewrite gets you signed into Google. It does not get you signed into everything that *uses* Google, and the two failures look nothing alike.

"Continue with Google" on a site like claude.ai does not navigate anywhere. It calls `window.open()`, sends you through Google in the popup, and waits. The popup's last page is a few lines of script:

```js
window.opener.postMessage(credential, origin);
window.close();
```

Both of those need a live `window.opener`. Electron refuses `window.open()` from a guest page whose `<webview>` carries no `allowpopups` attribute, and Obsidian does not set one. So the sign-in itself works, you pick your account, Google redirects to the callback, and the callback has nothing to talk to. The popup sits blank. The page that started the flow waits for a message that never arrives and reports a login error. Nothing in either window says what went wrong, because from each one's point of view nothing did.

Setting `allowpopups` gives the popup real window semantics: same session, same cookie jar, and an opener the callback can reach.

### The attribute is not enough

Obsidian installs its own `setWindowOpenHandler` on each guest in the main process, and a handler overrides the attribute outright. That handler opens the address in another web view, which is a separate top-level browsing context with no opener, so the popup arrives wearing Obsidian's chrome and the handshake is exactly as dead as it was before. The giveaway is visual: if the sign-in popup has an Obsidian title bar, Obsidian caught the `window.open()` and the attribute never got a say.

So the handler has to be replaced. That is harder than it sounds, because `setWindowOpenHandler` returns its verdict to the main process **synchronously**, and `@electron/remote` invokes renderer callbacks asynchronously. Hand it a function from here and the return value arrives long after Electron has given up and denied the window. The plugin's permission handling declines to cross that boundary for exactly this reason, and this is the same trap one API along.

The way through is to never send a function across at all. Compile the handler in the main process instead:

```js
const vm = require('@electron/remote').require('vm');

const install = vm.runInThisContext(`
  (function (webContents) {
    webContents.setWindowOpenHandler(function () {
      return { action: "allow" };
    });
    return true;
  })
`);

install(remote.webContents.fromId(webview.getWebContentsId()));
```

`install` is a main-process function. The only thing that crosses the boundary is the guest's `WebContents`, which is already a main-process object, so `@electron/remote` passes it back by reference rather than serialising it. The handler body closes over nothing in this realm and runs entirely in main, synchronously, the way Electron needs it to.

It has to run on `did-attach`, because the guest has no `WebContents` before that and Obsidian installs its handler as part of attaching. Ours goes in second and wins.

Nothing puts Obsidian's handler back, because `setWindowOpenHandler` has no getter. It does not need putting back: disabling the plugin rebuilds every web view, and the main process installs its handler again on each new guest.

The cost is that *every* `window.open()` in a web view becomes a real window, including ordinary `target="_blank"` links that used to open an Obsidian tab. That is what the **Open popups as real windows** setting turns off.

### Popups and the user agent

That introduces a second problem, which is why the session user agent matters here. A popup is a new `WebContents`, not the guest, so it does not inherit the element's `useragent` attribute. It takes the **session's** user agent instead, and on a partition Obsidian never initialised that is Obsidian's own UA, `obsidian/1.13.7 Electron/43.3.0` and all. Google blocks it. So the plugin also calls `session.setUserAgent()` on the clean partition through `@electron/remote`, which every later popup inherits. If `@electron/remote` cannot be loaded, that is now a console warning and a line in the settings tab rather than a silent `console.debug`, because on the popup path it is the difference between working and not.

## Why the partition is not called `vault-something`

Because Obsidian would delete it on every launch, and for a long time it did.

Electron stores a named partition in `<userData>/Partitions/<name>`, with the `persist:` prefix stripped. At startup, before any window exists, Obsidian's main process sweeps that directory:

```js
async function cleanPartitions() {
  let dir = path.join(userData, "Partitions");
  for (let name of await fs.promises.readdir(dir)) {
    let id = name.replace(/^vault-/, "");
    vaults[id] || await removePartition(id);
  }
}
async function removePartition(id) {
  console.log("Removing partition for vault " + id);
  return fs.promises.rm(path.join(userData, "Partitions", `vault-${id}`),
                        { recursive: true, force: true });
}
```

It is a garbage collector for vaults you have deleted: any directory named `vault-` plus something that is not a registered vault id gets `rm -rf`'d. `vault-<appId>-clean` is precisely that shape, so the web view cookie jar was written out correctly during the session and then destroyed before the next launch could read it. Sign-ins never survived a restart, and the reason was never anything to do with flushing.

Measured on Obsidian 1.13.7, across one quit-and-relaunch:

| | before | after |
| --- | --- | --- |
| `Partitions/vault-<appId>-clean/` created | 09:05:27 | **09:39:14** |
| its `Network/Cookies` | 36 KB, 48 rows, all persistent | **20 KB, empty schema** |
| its `Local Storage/leveldb/*.log` | 40381 B | **401 B** |
| `Partitions/vault-<appId>/Cookies` (Obsidian's own) | 288 KB | **288 KB, mtime unchanged** |

A name that does not begin with `vault-` survives, because the strip is then a no-op and the removal targets `Partitions/vault-<name>` — a path that does not exist, against an `rm` with `force: true`. Two probe directories through the same restart confirm it: `vault-zzprobe-deleteme` was deleted, `zzprobe-deleteme` was not.

That asymmetry between the name read and the path removed is a bug in Obsidian, and this plugin depends on it. It fails safe. If Obsidian ever fixes the sweep, web views go back to forgetting logins between restarts, which is exactly where they already were — nothing breaks, and nothing outside that directory is affected. Nothing else in Obsidian reads it.

## Install

### Via BRAT (recommended)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins.
2. `BRAT: Add a beta plugin for testing`.
3. Paste `https://github.com/imonroe/obsidian-webview-ua-override`.
4. Enable **Web Viewer UA Override** in Settings → Community plugins.

### Manual

1. Grab `main.js`, `manifest.json` and `versions.json` from the [latest release](https://github.com/imonroe/obsidian-webview-ua-override/releases/latest).
2. Drop them in `<your vault>/.obsidian/plugins/webview-ua-override/`.
3. Reload Obsidian and enable the plugin.

There is no build step. `main.js` is plain CommonJS, committed as-is, so you can also just clone the repo straight into your plugins folder and read every line before you trust it.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| **User agent** | empty | The UA string web views report. Empty means "take Obsidian's own UA and strip the `obsidian/` and `Electron/` tokens", which is exactly what Obsidian does for its own sessions and yields a normal Chrome UA. |
| **Partition suffix** | `clean` | Appended to the partition name. Change it to start a brand new cookie jar, which is the fastest way to sign out of everything at once. |
| **Allow popup windows** | on | Sets `allowpopups`, so Electron does not refuse `window.open()` outright. The cost is that any page in a web view can open a window unprompted, and ad blocking is off here. |
| **Open popups as real windows** | on | Replaces Obsidian's `window.open()` handler, so popups become real windows with a live `window.opener` instead of another web view. Required for popup-mode sign-ins. Turning it off sends popups, and every link that opens a new window, back to an Obsidian tab. |
| **Deny permission requests** | on | Denies camera, microphone, geolocation, notifications, MIDI, pointer lock, fullscreen and open-external requests from pages in web views. Leave it on. |
| **Debug logging** | off | Traces every web view to the console: creation, navigation, load failures, and the page's own console output. Turn it on to find out where a sign-in falls over, then turn it off. |

Settings apply to web views opened after you close the settings window. Existing ones keep what they were given.

## What to expect

**A fresh cookie jar, kept between launches.** The clean partition starts empty, so every site wants a new login the first time — once, not once per restart. Disabling the plugin puts you back on the original partition with your old cookies intact, untouched.

**No ad blocking in web views.** Obsidian's EasyList and EasyPrivacy filtering rides on the same handler that breaks Google sign-in. Skipping one skips the other. There is no way to keep just the good half: it is a single IPC handler, all or nothing.

**Permission coverage is partial, and deliberately so.** The element-level `permissionrequest` event covers what Electron routes through it (media, geolocation, notifications, midiSysex, pointerLock, fullscreen, openExternal) and this plugin denies all of it. Synchronous permission *checks* do not reach that event, and a fresh partition has no `setPermissionCheckHandler`, so Electron decides those with its own defaults.

The obvious idea is to install session handlers over `@electron/remote`. Do not. `setPermissionCheckHandler` returns a boolean synchronously to the main process, and a remote proxy stub returns before the renderer has run anything, so it would hard-deny every check including the clipboard permissions Obsidian itself grants. It would fail silently, which is the worst possible shape for this. Worse, Electron emits the webview `permissionrequest` event *from* the default permission request handler it installs for guest contents, so calling `setPermissionRequestHandler` replaces that outright and the element event stops firing. You would be trading the path that works for a proxied one that hangs.

## Verifying it took

Open the developer console with `Ctrl+Shift+I` (`Cmd+Opt+I` on macOS) and look for:

```
[webview-ua-override] active.
  partition: persist:wvua-xxxxxxxx-clean
  userAgent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...
```

The settings tab shows the same two values, plus the user agent popup windows will report. If that third line says the session user agent is not set, `@electron/remote` is missing and popup sign-ins will fail even though signing into Google directly works.

Then try signing into Google in a Web Viewer tab.

The quickest check on the popup path is visual. Click a "Continue with Google" button and look at the window that appears: an Obsidian title bar means Obsidian still owns `window.open()` and the takeover did not happen, and the settings tab's "Popup windows" line will say why. A bare window with no Obsidian chrome means the takeover worked.

If it still fails from there, turn on **Debug logging** and watch the console while you click the button. A `webview element created` line at that moment is the same finding in text form: the popup became a web view rather than a window.

If you ever see `create-browser-session passed through unrecognised args` in the console, Obsidian changed the IPC call shape and this plugin has stopped protecting the partition. That warning exists so the failure is visible instead of mysterious.

## Uninstalling, and how it reverts

Disabling the plugin unwinds all four patches and sends web views back to the original partition. Nothing persists.

Each restore captures the wrapper it installed and compares identity before unwinding. If another plugin wraps the same method after this one and you unload this one first, it backs off with a console warning rather than silently destroying the other plugin's patch. The unwind itself is unconditional and runs inside a `finally`, so a throw partway through startup cannot strand a patch.

## Compatibility

Developed and tested against **Obsidian 1.13.7** (Electron 43) on Windows. It should work anywhere Obsidian's desktop app runs. Desktop only, since it touches Electron.

This plugin depends on Obsidian internals that are not part of the public API: `App.getWebviewPartition`, the `create-browser-session` IPC channel, the `webviewer` view type, and the startup sweep of the `Partitions` directory described [above](#why-the-partition-is-not-called-vault-something). It checks for `getWebviewPartition` at load and refuses to patch anything if it is missing, but a future Obsidian release could still change the shape underneath it. Watch the console warning above.

**This plugin should eventually become unnecessary.** The right fix belongs in Obsidian: send a valid user agent, stop deleting security headers, and expose a supported way for plugins to create webviews with clean sessions. If that ships, disable this and carry on.

Two things here are worth reporting upstream on their own, independently of any of the above:

- The partition sweep reads directory `X` and deletes `vault-${X.replace(/^vault-/, "")}`. For every name it is meant to handle those are the same path, so the bug is invisible in normal use, but the two are not the same expression and a directory that does not start with `vault-` is never actually removed.
- There is no supported way for a plugin to hold a persistent web view session, because the sweep treats every partition that is not a live vault's as garbage.

## Releasing

Releases are cut from `main` by [the release workflow](.github/workflows/release.yml). Don't create them from the GitHub UI: Obsidian requires the release tag to match `manifest.json` exactly, so the workflow creates the tag itself.

To cut a release, on a feature branch:

1. Bump `version` in `manifest.json`.
2. Add the matching entry to `versions.json` (`"<version>": "<minAppVersion>"`).
3. Open a pull request and merge it into `main`.

The workflow then creates the tag, publishes the release, and attaches `main.js`, `manifest.json` and `versions.json` to it. Merging anything that doesn't change the version is a no-op, so ordinary merges never cut a release.

The same checks run on the pull request, so a `v`-prefixed version or a missing `versions.json` entry fails before the merge rather than after it. Step 2 is manual because a ruleset on `main` requires changes to arrive through a pull request, so the workflow can't commit it for you.

## License

[MIT](LICENSE)

## Credits

The root cause was diagnosed by Bryan Monge in [Obsidian forum thread 117394](https://forum.obsidian.md/t/cant-sign-in-to-google-in-web-viewer-401-malformed/117394), including the observation that a custom partition sidesteps the hooks. This plugin is an implementation of that finding.
