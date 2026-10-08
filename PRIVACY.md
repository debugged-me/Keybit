# KeyBit privacy policy

Last updated: October 8, 2026

KeyBit is a password manager that runs entirely in your browser. This policy explains what it handles and where that data goes.

## What KeyBit stores

KeyBit stores the items you save:
- **Logins:** website addresses, names, usernames, passwords, 2FA setup keys, notes, and the last five passwords of each login.
- **Secure notes.**
- **Cards and identity records:** card numbers, expiry, security codes, cardholder names, and the names, addresses, phones, and other fields you save for form filling.
- **Passkeys:** the private credential material for each passkey you keep, together with its relying party and sign count.
- **Projects and favourites,** including any environment addresses you set on a project.

They are encrypted with a key derived from your master password (AES-256-GCM) and saved in your browser's extension storage on your device. Backups, portable vault files, and recovery kits are encrypted copies of the same vault data; a recovery kit's passphrase is split into shares (Shamir's scheme) that you distribute yourself — KeyBit never keeps the shares.

KeyBit also keeps a few things that are not secret:
- **site rules** — the sites where KeyBit is on or off, and whether it may offer logins, save prompts, or link previews there;
- when each login was last used (by a random ID, not by site);
- your generator, theme, and Peek choices;
- the dates of your backups.

If you turn on Touch ID or Windows Hello, your device creates a passkey for KeyBit. That passkey, not your master password, unlocks a sealed copy of the vault key.

Your master password is never stored. Without it, KeyBit cannot decrypt your data, and it cannot recover a forgotten master password.

## What KeyBit reads on websites

To suggest and save logins, KeyBit looks for sign-in, sign-up, password-change, and 2FA code fields on the pages you visit. When you submit one of these forms, it reads the username and password you entered so it can ask whether to save them. Nothing is saved unless you confirm. Unconfirmed values are discarded within two minutes.

For Peek, KeyBit checks the link you activate and loads eligible destinations in a preview inside the page. The destination receives a normal browser request and may use its own cookies and privacy policy. A small script in embedded pages reports preview readiness and Escape key presses; it does not read their contents or access the vault. Preview history is not stored by KeyBit.

The command palette searches your vault titles and commands on your device — nothing is sent anywhere. The form inspector reports the *structure* of sign-in fields on the tab you inspect (field types, autocomplete attributes, which frame they live in); it never reads or reports the values in them.

## What KeyBit shares

KeyBit has no servers and does not send your vault data to a service. It does not collect analytics, usage data, or crash reports, and it does not sell your data. Peek loads the website you choose directly, as described above, without sending it saved credentials. Encrypted backup files are written only where you choose, either with **Export** or to the folder you pick for automatic backups.

## Removing your data

Removing KeyBit from your browser deletes its stored vault and settings. Backup files you exported or saved to a folder stay where you put them. If you used Touch ID or Windows Hello, you can delete the "KeyBit vault" passkey in your system's password settings.

## Contact

Questions about this policy: [add the contact email for your store listing]
