# Permission profile capability fixture

This fixture verifies that a Codex permission profile can read a normal
workspace file while denying direct reads from `docs/user`, `docs/report`, and
`.assistant/vault`.

The test is successful only when:

1. `public.txt` is readable under the selected profile.
2. Every restricted canary is denied under the same profile.
3. A separate host-side gateway prototype can read an exact restricted path
   after validating an explicit grant.

The fixture is synthetic. Its path and filenames are not runtime assumptions.
