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

Enrolment connects this Mac to your organisation and downloads the signed rules. The Mac pins the server's signing
key and refuses rules signed by any other key.

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

Tools that send their traffic to Guard as a proxy (`HTTPS_PROXY`) behave differently. They wait up to about 90
seconds for you to trust a new certificate, then go through unchecked. While the app is restarting or not
responding, they wait or fail until it is back.

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
| Quit Vibtra Guard | Hides the menu bar icon and windows. Guard keeps running and checking traffic. Open Vibtra Guard again to see it. To quit the app fully, for example to replace it, choose Stop Guard… first, then Quit. |

There is no native Overview, Activity or Rules window. Rules, activity, devices and requests are in the web
dashboard only. This is decision 0001 (`docs/decisions/0001-web-dashboard-only.md`).

Next: [set rules](rules.md), then [check it works](check.md).
