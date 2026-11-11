# Cloud sources for ShopPost Library

Create the OAuth registrations under the organization's provider accounts. Install the client secrets as production Worker secrets, never in the repository or browser bundle. The callback must match the production origin exactly.

| Source | App settings | Production callback |
| --- | --- | --- |
| Dropbox | Scoped API. Enable `account_info.read`, `files.metadata.read`, `files.content.read`. Use Full Dropbox only if the organization needs to browse existing files outside an app folder. | `https://shoppost.net/api/library/dropbox/callback` |
| OneDrive | Microsoft Entra Web app registration supporting the chosen Microsoft accounts. Add delegated Graph permissions `User.Read`, `Files.Read`. | `https://shoppost.net/api/library/onedrive/callback` |
| Outlook attachments | Same Microsoft registration with delegated `Mail.Read` and a second callback. The Outlook and OneDrive grants request their scopes separately. | `https://shoppost.net/api/library/email/callback` |

Configure `DROPBOX_CLIENT_ID`, `DROPBOX_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` on the production Worker. `PUBLIC_ORIGIN` and `SOCIAL_TOKEN_KEY` are existing runtime settings. Credentials are stored by shop, provider and consenting ShopPost user.

In the Library, connect one source and consent at the provider. Confirm the account name, list folders or messages, and import a small disposable file. Reload ShopPost, download the imported asset and compare it to the original bytes. Check that another ShopPost member cannot use the grant. Outlook imports file attachments, excluding inline and reference attachments. The picker filters the current page and supports pagination. It does not synchronize storage or modify the provider files.
