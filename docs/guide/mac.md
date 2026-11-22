# Install the Mac app

You need a Mac with macOS 14 or later on Apple silicon, and an enrol link from your administrator.

## 1. Install

- Download `VibtraGuard-arm64.zip` and its checksum from the [download table](README.md#download).
- Check the checksum, unzip it, move `VibtraGuard.app` to `/Applications` and open it.

```sh
shasum -a 256 -c VibtraGuard-arm64.zip.sha256   # prints "VibtraGuard-arm64.zip: OK"
```

Vibtra Guard runs in the menu bar. It has no Dock icon and opens no window at launch. Click its menu-bar icon to
open the panel. If the icon is hidden because you chose Quit, open Vibtra Guard again to bring it back.

If your organisation signs Guard under its own Apple team, your IT team delivers the app and its profile with your
device-management tool instead, and the app may already be on your Mac. See [self-signing.md](self-signing.md).

Building from source gives an unsigned development build. macOS will not turn on the network extension from an
unsigned build, so it cannot protect a Mac. It is for development only (`zsh guard/mac/build.sh --unsigned`).
A `build.sh` build that is not signed by your Apple team (`--unsigned`, or when team signing fails) does not check
AI traffic either. The traffic goes through unchecked, and the status says `interception off: unsigned build`.

## 2. Enrol

Your administrator makes an enrol link for you on the dashboard's **Devices** page. It works once and expires,
24 hours by default.

- **Link:** open the `vibtra-guard://enrol?...` link on your Mac. The app opens and enrols. Or choose **Enrol…** in
  the panel and paste the link.
- **Command:** the dashboard can also show an enrol command. The command is in the app bundle, so run it as:

  ```sh
  /Applications/VibtraGuard.app/Contents/MacOS/vibtra-guard enrol --server <server> --token <token>
  ```

  It prints `Enrolled and synced. Trust the local CA, then run the agent.`

Enrolment connects this Mac to your organisation and downloads the signed rules. At enrolment the Mac pins the
server's signing key in the keychain, in a group that only Guard code signed by your Apple team can write. Guard
checks every set of rules with that pinned key and refuses rules signed by any other key. `device.json`, in Guard's
data folder, holds no signing key, and Guard never reads one from it. If `device.json` names another device or
organisation than the pinned key, Guard keeps the last rules it checked and the panel shows a **Signing key** problem.
Enrol again to repair it.

The agent reads the pinned key from the Guard app over a local socket. Before it trusts an answer, it checks that the
process on the other end is the Guard app, signed by the same team as the agent. When the app is not running, the
agent keeps the rules it already checked, but it cannot load rules after a restart until the app is back.

When the keychain holds no pinned key, the agent loads no rules and asks the server for the server's signing key
over its signed-in device connection. It pins that key and then loads rules. Until the server answers, the panel
shows that Guard is fetching the signing key. A failed fetch is retried after 10 seconds, then after twice as long
each time, up to 10 minutes. Only one fetch runs at a time. A key from the server never replaces a key that is
already pinned: if the server's key changes, enrol the Mac again. If the Mac is enrolled again while a fetch is
running, the fetched key is thrown away. When the keychain cannot be read, the agent does not ask the server; it
keeps the rules it already checked. A running agent keeps the key it loaded even if the pin is removed from the
keychain; it fetches a key only after it restarts with no pin. A pin that an earlier version of Guard took from
`device.json` is not trusted: the panel says so and Guard asks you to enrol again. Builds of the agent that are not
signed by an Apple team (for example a local development build) cannot use the keychain group; they keep the pin in
a file in the data folder and report the store as `unprotected`.

### Which server Guard talks to

The address of your organisation's server is built into a signed copy of Guard. The build compiles it into the agent,
so patching it breaks the agent's code signature and macOS refuses to run the agent. Someone with an administrator
account can still re-sign a patched agent themselves. It then runs as an unsigned copy: it takes any server, keeps its
signing key in a file the person can change, and the console's **Policy signing key** row says "in a file the person
can change". Treat that row as the sign that a Mac's copy of Guard is not the one you shipped. A signed copy of Guard talks
only to that server: for enrolment, for the signing key and for every sync. It refuses any other address, from an
enrol link, from `enrol --server` or from an edited `device.json`, and the panel shows a **Server** problem. The
**Enrol…** window shows the built-in server and does not offer another. The command enrols with the built-in server
when you leave out `--server`:

```sh
/Applications/VibtraGuard.app/Contents/MacOS/vibtra-guard enrol --token <token>
/Applications/VibtraGuard.app/Contents/MacOS/vibtra-guard registry   # {"fixed":true,"origin":"https://vibtra.app"}
```

Vibtra's download is built for `https://vibtra.app`. To use Guard with your own server, sign Guard for that server
([self-signing.md](self-signing.md)). A signed copy built without a server address talks to no server, and the panel
says so. Copies of Guard that are not signed by an Apple team take any server address, as before, and report their
key store as `unprotected`.

A signed copy checks the server's certificate against a fixed list of public certificate authorities built into the
agent (Mozilla's list), not against the authorities your Mac trusts. A certificate authority added to a keychain,
by you, by a person on the Mac or by a profile, therefore cannot vouch for a fake server. If your server's certificate
comes from a private certificate authority, build Guard with that authority's certificate
([self-signing.md](self-signing.md#a-server-with-a-private-certificate-authority)). Copies of Guard that are not signed
by an Apple team use the certificate authorities your Mac trusts.

If a Mac's `device.json` names another server than the built-in one, Guard keeps its last verified rules, makes no
call to any server, writes one error line to its log and shows `registry-origin-mismatch` in `vibtra-guard status`
and as a **Server** problem in the panel. Enrol the Mac again with a copy of Guard built for its server.

## 3. Trust the Guard certificate

Choose **Trust the Guard certificate** in the panel. Guard made this certificate on your Mac. Its private key is
kept in your Mac's Secure Enclave, a chip that holds keys and never hands them out. The key cannot be copied off the
Mac or out of a backup, and only Guard can use it. Guard uses it only for the AI services in its catalogue, so it can
check what is sent to them. Traffic to any other site passes through unread.

macOS asks for your login password to change certificate trust settings. Nothing is sent anywhere.

If the key is ever gone (for example, after a keychain reset or a move to a new Mac), Guard makes a new certificate
and the panel asks you to trust it. Until you do, Guard cannot check AI requests, and they go through unchecked
within a few seconds.

A Mac without a Secure Enclave, such as a virtual machine, cannot keep the key safe. The same happens on a Mac
where Guard cannot make a key. Guard does not check AI traffic there, and the traffic goes through unchecked. The
panel shows **This Mac is not protected**, and your administrator's dashboard lists the Mac as not protected.
Your organisation's app and website switches and content rules do not apply on such a Mac. See
[When Guard cannot inspect](coverage.md#when-guard-cannot-inspect).

While the Guard app is restarting or not responding, AI requests also go through unchecked within a few seconds.
See [Availability: Guard fails open](coverage.md#availability-guard-fails-open). Other sites are not affected. The
same happens when Guard cannot sign a certificate for one site; see
[When Guard cannot inspect](coverage.md#when-guard-cannot-inspect).

### Command-line tools

Many command-line tools (Node, Python, curl, git) do not read the macOS keychain. Choose
**Trust for command-line tools…**. The app writes `guard-ca.pem` and `guard-ca-bundle.pem` to
`~/Library/Application Support/Vibtra Guard` and shows lines to add to your shell profile, such as
`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` and `GIT_SSL_CAINFO`. Open a new
terminal after you add them.

## 4. Turn on the network extension

The panel shows one action for the extension, from the state macOS reports and the extension this app bundles:

- **Install network extension**: macOS asks you to allow it in System Settings, and may ask for an administrator
  password.
- **Open Network Extensions settings**: approval is still waiting in System Settings.
- **Turn on network protection**: the extension is installed but not routing traffic yet.
- **Turn off network protection**: it is on.
- **Update network extension**: this copy of the app bundles a newer extension. macOS asks you to approve the update.

The extension sends traffic for the AI services in the catalogue to the Guard agent on your Mac. Everything else is
untouched.

## 5. Notifications

When a blocked request comes from an app or from a page's background request, there is no page to show. Guard posts
one desktop notification instead. Allow notifications for Vibtra Guard when macOS asks. Clicking it opens Guard's
block page.

How the notification permission prompt and click-through behave on the signed release has not been checked on a Mac
yet.

## The menu-bar panel

The panel shows who you are, your organisation, the mode (Monitor or Enforce), the **Last sync** time, and today's
allowed, blocked and asked counts. Its actions:

| Action | What it does |
|---|---|
| Open web dashboard | Opens `<server>/<organisation>/guard` from your enrolment. Needs administrator access. |
| Enrol… | Enrols with a link or token. |
| Trust the Guard certificate | Trusts this Mac's Guard certificate in your login keychain. |
| Trust for command-line tools… | Writes the certificate files and shows the shell lines. |
| Start Guard / Stop Guard… | Starts or stops the local Guard agent. Stop Guard… asks first. |
| Open block page | Opens the page for the last block. |
| The extension action | One of the actions listed under step 4. |
| Open agent log | `~/Library/Logs/Vibtra Guard/agent.log`. |
| Remove Guard… | Removes Guard from this Mac. See [removal.md](removal.md). |
| Quit Vibtra Guard | Hides the menu bar icon and windows. Guard keeps running and checking traffic. Open Vibtra Guard again to see it. To quit the app fully, for example to replace it, choose Stop Guard… first, then Quit. If you started the agent yourself, stop it there first. |

There is no native Overview, Activity or Rules window. Rules, activity, devices and requests are in the web
dashboard only. This is decision 0001 (`docs/decisions/0001-web-dashboard-only.md`).

Next: [set rules](rules.md), then [check it works](check.md).
