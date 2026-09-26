# Tally on an LG TV

This guide puts Tally on an LG smart TV from 2020 or later (webOS 5 and newer). You do it once and it takes about
20 minutes. After that, Tally updates itself from the Jellyfin server.

**You need:**

- The LG TV, switched on and connected to the internet.
- A computer on the same home network as the TV (the same Wi-Fi or router). Windows 10 or 11, a Mac, or Linux.
- A free **LG developer account**. You make one in step 2 if you don't have one.
- The **address of the Jellyfin server** and **your Jellyfin account**. The person who runs the server gives you both.
  The address looks like `https://jellyfin.example.com` or `192.168.1.10:8096`.

There are four steps:

1. Download the installer on the computer.
2. Turn on Developer Mode on the TV.
3. Let the installer put Tally on the TV.
4. Sign in on the TV with a code.

## 1. Get the installer

Download the file for your computer from the
[latest Tally release](https://github.com/Scdouglas1999/Tally/releases/latest):

| Computer | File |
|---|---|
| Windows | `Tally-LG-Installer-windows.exe` |
| Mac with Apple silicon (M1 and later) | `Tally-LG-Installer-macos-arm64` |
| Mac with an Intel processor | `Tally-LG-Installer-macos-x64` |
| Linux | `Tally-LG-Installer-linux` |

You don't need to install anything else. Don't open it yet; set up the TV first.

## 2. Turn on Developer Mode on the TV

Developer Mode lets the TV accept an app from your computer. LG gives it out through a free app and a free LG
developer account.

1. **Make an LG developer account.** On the computer or your phone, open
   [webostv.developer.lge.com](https://webostv.developer.lge.com), choose **Sign In**, then **Create Account**, and
   follow the steps. It's free. You only need the email address (your ID) and password.
2. **Install the Developer Mode app on the TV.** On the remote, press **Home**, open **Apps** (the LG Content Store),
   search for **Developer Mode** and install it.
3. **Open Developer Mode and sign in** with the LG developer account from step 1.
4. **Switch Dev Mode Status on.** The TV asks to restart. Let it.
5. **Open Developer Mode again and switch Key Server on.** The app now shows the TV's **IP** and a **Passphrase** (six
   letters and digits, like `78DB5E`). Leave this screen open: the installer needs the passphrase in a moment.

The app also shows how long Developer Mode lasts (**Remain Session**). LG removes apps like Tally when that time runs
out. You don't have to watch it: once someone has signed in to Tally on the TV, the Jellyfin server renews the session
every day (see [Later](#later)).

## 3. Let the installer put Tally on the TV

Open the installer on the computer:

- **Windows:** double-click it.
  - The first time, Windows may show **"Windows protected your PC"**, because the program is new and not from a large
    company. Click **More info**, then **Run anyway**.
  - A black window opens. This is the installer.
- **Mac:** open **Terminal** and type the lines below. Use `x64` instead of `arm64` on an Intel Mac.

  ```sh
  cd ~/Downloads
  chmod +x Tally-LG-Installer-macos-arm64
  xattr -d com.apple.quarantine Tally-LG-Installer-macos-arm64
  ./Tally-LG-Installer-macos-arm64
  ```

- **Linux:** in a terminal, run `chmod +x Tally-LG-Installer-linux && ./Tally-LG-Installer-linux`.

It walks you through four steps. Most of the time you only press **Enter**, type the passphrase and the server address.

1. **Find your TV.** The installer looks for the TV, then lists it with a status:
   - **"Developer Mode is on, Key Server is on: ready":** press **Enter**.
   - **"Key Server is off":** switch Key Server on in the Developer Mode app, then press **Enter** to look again.
   - **"Developer Mode is off"**, or no TV found: go back to step 2. You can also type the TV's IP address, the one the
     Developer Mode app shows.
2. **Your TV.** The installer gets the TV's key from its Key Server and asks for the **passphrase**. Type the six
   letters and digits the Developer Mode app shows and press **Enter**. It then connects and shows the TV's webOS
   version and model.
3. **Your Jellyfin server.** Type the server address you were given and press **Enter**. The installer checks that
   the server answers.
4. **Install.** The installer puts Tally on the TV and starts it. It says **"Tally is installed"** when it's done.

You can switch Key Server off again afterwards. The installer keeps the TV's key on the computer, so an update from the
same computer doesn't need it (unless Developer Mode was switched off and on in between).

## 4. Sign in on the TV

Tally opens on the TV with a **6-digit code**. To use it:

1. On your phone or a computer, open Jellyfin (the same server) and sign in.
2. Open your profile (the picture or initial at the top), then **Quick Connect**.
3. Type the code from the TV and press **Authorize**. The TV signs in by itself.

If Quick Connect isn't turned on for the server, choose **Use username/password** on the TV instead.

From now on, Tally is in the TV's apps list.

**The Magic Remote works as a pointer too:** point at a card to select it, click to open it, and roll the wheel to
move between rows. The arrow keys work as on any remote.

## Later

- **Developer Mode stays on by itself.** Once someone has signed in to Tally on the TV, the TV hands the Developer Mode
  session to the Jellyfin server, and the server renews it every day. The server's Tally settings page (Settings, the
  **Tally on a TV** card) shows **"LG Developer Mode kept on for 1 TV · renewed …"**. If the server can't renew it
  (for example it was off for weeks), open the Developer Mode app on the TV and press **EXTEND** before the time runs
  out. Once it has run out, LG turns Developer Mode off and removes Tally; then do steps 2 and 3 again.
- **Updates come from the server.** When the server's Tally plugin is updated, Tally on the TV updates the next time
  it starts. Run the installer again only if Tally on the TV asks you to reinstall it, or if it was removed.
- **Keep the installer's folder.** It keeps the TV's key there, so the next install needs no passphrase:
  - Windows: `%APPDATA%\Tally\LG`
  - Linux: `~/.config/Tally/LG`
  - Mac: the folder shown at the end of the installer
- The installer writes what it did to `Tally-LG-Installer.log` in the computer's temp folder. Send that file when
  asking for help.

## If something goes wrong

| The installer says | What to do |
|---|---|
| "The TV's Key Server did not answer" | Open the Developer Mode app on the TV and switch **Key Server** on. Check that the IP it shows is the one the installer used. |
| "That passphrase does not unlock the TV's key" | Type the passphrase again, exactly as the Developer Mode app shows it (capital letters and digits). |
| "Nothing answered on Developer Mode's port" | Developer Mode is off, or the TV has not restarted since you switched it on. Open the Developer Mode app, check **Dev Mode Status** is on, and restart the TV if it asks. |
| "The TV did not accept its key" | Developer Mode was switched off and on since the key was fetched. Switch Key Server on and run the installer again. |
| "No Jellyfin server answered" | Check the address with the server's owner. Try it in the computer's browser, where it should open Jellyfin. |
| "This server does not have Tally's TV app yet" | Ask the server's owner to install or update the Tally plugin. Tally installs anyway. |
| "The TV does not have enough free space" | Remove an app you don't use from the TV and run the installer again. |
| "Tally needs a 2020 or newer LG TV" | Tally needs webOS 5 or newer. Older LG TVs can't run it. |
| "This TV did not give its Developer Mode session" | The server can't keep Developer Mode on for this TV. Open the Developer Mode app now and then and press **EXTEND**. |

Run the installer with `--help` for its other options.
