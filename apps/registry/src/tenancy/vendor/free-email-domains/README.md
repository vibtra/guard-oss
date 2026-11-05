# free-email-domains (vendored data)

`domains.json` is the domain list from [free-email-domains](https://github.com/Kikobeats/free-email-domains) 1.12.21
(MIT, Kiko Beats; `LICENSE.md` beside it is the package's own licence, verbatim), lower-cased, de-duplicated and sorted.
It is read by `../../public-domains.ts` (M3, DECISIONS.md m3-8: a business email is needed to create an organisation).
To refresh: `npm pack free-email-domains@<version>`, re-run the same transform, bump the version here and in
`scripts/third-party-manifest.mjs` (`VENDORED_REGISTRY`), and run `pnpm licence:manifest`.
