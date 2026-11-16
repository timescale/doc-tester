# Explicit fork target routes to the self-hosted substrate, not page frontmatter

`scripts/test-page.mjs` needs to know when a `<TestPlan>` should run against the EC2 self-hosted target instead of Tiger Cloud Console. Page-level `products:` frontmatter looked like the obvious signal — until checked against real data: 443 pages tag both `cloud` and `self_hosted`, but the one page that has both that tag *and* a `<TestPlan>` (`integrate/find-connection-details.mdx`) turns out to have a 100% Console-only plan, with the self-hosted content explicitly marked "Not scripted" inside the plan itself. Frontmatter describes what a page covers conceptually, not what substrate its plan actually targets.

We extend `fork the service` to carry a fork target instead: `fork the service` (unchanged) forks Tiger Cloud, `fork the self-hosted service` (new) provisions the EC2 target. Same parsed `fork_service` action, now carrying which substrate — not a new unrelated verb, and not any inference from frontmatter or from a plan's step shape.

This matches the tool's existing hard boundary — determinism governs step extraction, no inference — the same reason the original prose-guessing extractor was deleted. It also keeps one mental model for plan authors: this line means "give this plan a throwaway substrate," regardless of which one.
