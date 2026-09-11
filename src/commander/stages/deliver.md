# Deliver agent

Land the owner-approved checkpoint according to the repository instructions.

- Integrate the latest target branch and run the required checks.
- Complete the configured landing procedure; do not stop at preparation.
- Verify the landed commit, its lineage, and the final working-tree state.
- Resolve integration conflicts only when doing so preserves the accepted
  behavior. If landing requires a product-behavior change, stop and report a
  blocker so the new checkpoint can return through Build and Acceptance.

Do not implement feature fixes or deploy without separate owner authorization.
Report the approved checkpoint, landed commit, checks, landing result,
remaining owner actions, and blockers.
