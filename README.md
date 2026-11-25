# Med Card Pass

Turn a medical card PDF into a wallet pass, right in the browser.

The page always builds a `.pkpass` (pass.json with the card's QR code as the barcode, the patient ID, name and dates as fields, icons and a manifest) in the browser.

- **With an Apple pass certificate set up** on the site, the pass is Apple-signed and opens in Apple Wallet and anywhere else that takes `.pkpass` files.
- **Without one**, the page signs a **test pass** in the browser with a throwaway self-signed certificate, and also offers an unsigned copy. Apple Wallet rejects both. Google Wallet on Android can import `.pkpass` files; Google doesn't document whether it checks the signature, so the test pass is there to find out.
- **Fallback:** a clean card image with a large QR code, added through Google Wallet's **Add to Wallet → Photo** option.

It was built around the Utah medical cannabis card PDF from EVS, but it reads any one-page card PDF that has a QR code. Every field can be edited before you save.

## Privacy

- The PDF is read in the browser with [pdf.js](https://mozilla.github.io/pdf.js/) and [jsQR](https://github.com/cozmo/jsQR). It is never uploaded.
- The new QR code holds exactly the same text as the card's QR code.
- A test pass is signed entirely in the browser; nothing is sent anywhere.
- For an Apple-signed pass, the browser builds the whole pass itself. It sends the site only `manifest.json`: the pass's file names and their SHA-1 hashes. The server signs that and sends the signature back. Your name, ID, dates and QR text never reach the server. `pass.json` carries a random serial number, so its hash can't be guessed from the card's details.
- Nothing is logged or stored by the site's code.

## How it works

```
public/        static site (index.html, app.js, core.js, pass.js)
  core.js      PDF parsing: QR code, patient ID, name, dates, provider; draws the card image
  pass.js      builds pass.json, icons and manifest.json; zips the .pkpass
functions/api  Cloudflare Pages Functions
  config.js    GET  /api/config  says whether signing is set up
  sign.js      POST /api/sign    signs a manifest.json (hashes only)
src/cms.js     dependency-free PKCS#7 detached signature and test certificate using WebCrypto
               (copied to public/vendor/cms.js at build time for test passes)
```

Apple signing is optional. With no certificate configured, `/api/config` reports `signing: false` and the page makes test passes (self-signed or unsigned) in the browser. A plain static host with no `/api` behaves the same way.

## Deploy to Cloudflare Pages

1. Create a Pages project from this repo.
2. Build command: `npm run build`. Build output directory: `public`.

That's enough for test passes and the card image.

## Turn on Apple Wallet passes

You need an Apple Developer Program membership.

1. In Certificates, Identifiers & Profiles, create a **Pass Type ID** (for example `pass.com.example.medcard`). Then create a certificate for it and export it from Keychain as `pass.p12`.
2. Convert it to PEM files. The key must be unencrypted PKCS#8:
   ```sh
   openssl pkcs12 -legacy -in pass.p12 -clcerts -nokeys -out pass-cert.pem
   openssl pkcs12 -legacy -in pass.p12 -nocerts -nodes | openssl pkcs8 -topk8 -nocrypt -out pass-key.pem
   ```
3. Download the Apple WWDR intermediate certificate (G4) from [Apple PKI](https://www.apple.com/certificateauthority/) and convert it:
   ```sh
   openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem
   ```
4. In the Pages project settings, add the plain variables `PASS_TYPE_ID` (your Pass Type ID), `TEAM_ID` (your Apple team ID) and `ORG_NAME` (the name shown on the pass). Then add the secrets:
   ```sh
   npx wrangler pages secret put PASS_CERT_PEM --project-name med-card-pass < pass-cert.pem
   npx wrangler pages secret put PASS_KEY_PEM  --project-name med-card-pass < pass-key.pem
   npx wrangler pages secret put WWDR_CERT_PEM --project-name med-card-pass < wwdr.pem
   ```
5. Redeploy. The **Add to Apple Wallet** button appears.

Don't commit any of these files. `.gitignore` already excludes `*.pem`, `*.p12` and `*.key`.

### A note for issuers

`/api/sign` signs any well-formed manifest, so anyone who can reach the site can get passes signed under its Pass Type ID. That is the cost of never seeing the card's contents. If you run this publicly, add a Cloudflare rate-limiting rule or Turnstile in front of `/api/sign`.

A card issuer, such as a state program, is best placed to run this with its own Pass Type ID. Its name then appears on the pass, and it could limit signing to cards it issued.

## Development

```sh
npm install
npm test        # parses a made-up sample card, builds and signs a pass with a throwaway cert, verifies it with OpenSSL
npm run dev     # wrangler pages dev on public/
```

The tests need OpenSSL on the path.

## Disclaimer

This is not affiliated with any state program or with Apple or Google. A wallet pass made here is a convenience copy. Carry your official card, since a pharmacy or officer may ask for it.

## License

MIT
