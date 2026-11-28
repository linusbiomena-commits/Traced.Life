# Publishing the approved consent documents

**Phase 8E.** Server-side command `publish-consent`:
- code: `server/src/cli/publish-consent.ts` and `server/src/modules/consents/publish.ts`;
- migration `0012_consent_publishing.sql`;
- tests: `server/test/consent-publish.test.ts`.

Use it only with **final, approved** texts and the real approval reference(s). Claude does not write legal or clinical wording or approval references.

## What it guarantees

- **Document types:** all four, each in English **and** Arabic: `privacy_policy`, `sample_collection_consent`, `accuracy_declaration`, `guardian_authorization`.
- **Complete sets only:** a release must contain the whole set (4 types × 2 languages). `--partial` adds or replaces individual types, but only if every other type already has an approved English + Arabic version. English and Arabic of one type must share the same version.
- **Required fields:** title, text, version (letters, digits, dot, hyphen; no "provisional", "draft" or "test"), approval reference (3–200 characters, one line), and effective date-time with time zone (not back-dated, at most a year ahead).
- **Refused text:** provisional or placeholder wording ("provisional", "not legally approved", "draft", "lorem ipsum", "TODO", "TBD"); an Arabic document without Arabic text (or the reverse); synthetic test content when the target is production.
- **Authorised publisher:** an **active super administrator** (permission `consent.manage`); in production, with two-step verification enrolled.
- **What each document records:**
  - status `approved`;
  - the approval reference;
  - the publisher (`published_by`, `approved_by`);
  - the publication timestamp (`approved_at`);
  - `effective_from`;
  - the SHA-256 checksum of title and text.
- **No overwriting:** a version that already exists is **refused**, even with identical text. Earlier versions and every customer's consent record stay exactly as they were.
- **Immutable afterwards:** the database refuses changes to the text, approval reference, publisher, dates or status. The only allowed change is retiring a document. A provisional document can never become approved; approval is always a new version.
- **All or nothing:** every document in a release is written in **one transaction**, with one `consent.published` audit entry per document (type, language, version, checksum, reference, effective date).
- **Restricted permissions:** on the server it connects as `traced_app`, which can only read and insert consent documents.
- **`--dry-run`** validates everything against the database and writes nothing. A run must say either `--dry-run` or `--publish`.
- **Target safety:** `--target production` works only on the production database `traced`. Any other target refuses `traced`.

Customers see a new version from its effective date. Their earlier acceptances stay linked to the exact text they accepted.

## Preparing the release folder (you)

Create a folder with plain UTF-8 text files and a `manifest.json`:

```
consents-v1.0/
  manifest.json
  privacy_policy.en.txt              privacy_policy.ar.txt
  sample_collection_consent.en.txt   sample_collection_consent.ar.txt
  accuracy_declaration.en.txt        accuracy_declaration.ar.txt
  guardian_authorization.en.txt      guardian_authorization.ar.txt
```

```json
{
  "version": "1.0",
  "effectiveFrom": "2026-12-01T00:00:00+03:00",
  "approvalReference": "<the reference on the signed approval>",
  "documents": [
    { "type": "privacy_policy", "locale": "en", "title": "<approved English title>", "bodyFile": "privacy_policy.en.txt" },
    { "type": "privacy_policy", "locale": "ar", "title": "<approved Arabic title>",  "bodyFile": "privacy_policy.ar.txt" }
  ]
}
```

List all eight documents.
- A document may override `version` or `approvalReference` (for example, if the guardian authorisation was approved separately), but English and Arabic of one type must match.
- Paragraphs are separated by blank lines in the text files. Leading and trailing spaces are trimmed, and Windows line endings and a BOM are normalised.

## Loading (after the production switch and after the super admins exist)

1. **Upload** (from this repository, after `oci session authenticate`):
   `bash deploy/oci/upload-consent-release.sh <folder> consents-v1.0`
2. **Dry run** on the server:
   `bash deploy/oci/vmrun.sh vm/vm_21_publish_consent.sh consents-v1.0 <super-admin email> dry-run`.
   Check the eight lines: type, language, version, checksum, length, reference, title.
3. **Publish** (only with your go-ahead):
   `bash deploy/oci/vmrun.sh vm/vm_21_publish_consent.sh consents-v1.0 <super-admin email> publish`
4. **Verify:**
   - the admin audit log shows 8 × `consent.published`;
   - registration step 5 shows the approved texts from the effective date (EN and AR);
   - Audit integrity check passes.

`vm_21` runs against the database the API currently uses, and in production mode the target is production. The server image must include this command and migration 0012: build it with `vm_02_migrate.sh <vault> <commit> traced`. That migration changes the production schema (additive), so it runs only with your authorisation.

**Later changes:** publish a new version (for example `1.1`) with a new reference and effective date. Never edit an old one.
