# KeyBit privacy policy

Last updated: October 8, 2026

KeyBit is a password manager that runs entirely in your browser. This policy explains what it handles and where that data goes.

## What KeyBit stores

KeyBit stores the items you save:
- **Logins:** website addresses, names, usernames, passwords, 2FA setup keys, notes, and the last five passwords of each login.
- **Secure notes.**
- **Projects and favourites.**

They are encrypted with a key derived from your master password (AES-256-GCM) and saved in your browser's extension storage on your device.

KeyBit also keeps a few things that are not secret:
- sites where you turned KeyBit off;
- when each login was last used (by a random ID, not by site);
- your generator and theme choices;
- the dates of your backups.

If you turn on Touch ID or Windows Hello, your device creates a passkey for KeyBit. That passkey, not your master password, unlocks a sealed copy of the vault key.

Your master password is never stored. Without it, KeyBit cannot decrypt your data, and it cannot recover a forgotten master password.

## What KeyBit reads on websites

To suggest and save logins, KeyBit looks for sign-in, sign-up, password-change, and 2FA code fields on the pages you visit. When you submit one of these forms, it reads the username and password you entered so it can ask whether to save them. Nothing is saved unless you confirm. Unconfirmed values are discarded within two minutes.

## What KeyBit shares

Nothing. KeyBit has no servers and makes no network requests. It does not collect analytics, usage data, or crash reports, and it does not sell, transfer, or share any data. Encrypted backup files are written only where you choose, either with **Export** or to the folder you pick for automatic backups.

## Removing your data

Removing KeyBit from your browser deletes its stored vault and settings. Backup files you exported or saved to a folder stay where you put them. If you used Touch ID or Windows Hello, you can delete the "KeyBit vault" passkey in your system's password settings.

## Contact

Questions about this policy: [add the contact email for your store listing]
