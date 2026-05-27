# RFC Process

Use RFCs for blocking product or architecture issues that require multi-party feedback.

## When To Create An RFC

Create an RFC when work is blocked by:

- Architecture direction
- Product scope
- API contracts
- Data model or migration design
- Cross-role dependencies
- Deployment or rollback risk
- High regression risk

## Directory Layout

Each RFC uses this structure:

```text
rfcs/RFC-0001-short-title/
  proposal.md
  comments/
    <role>.md
  votes/
    <role>.md
  decision.md
```

## Status Values

- Open
- FeedbackRequested
- Voting
- DecisionPending
- Accepted
- Rejected
- Superseded

## Rules

- Related implementation pauses while the RFC status is Open.
- Each role writes only its own comment file.
- Each voting role votes with `.multi-agent/scripts/agentctl vote-rfc <role> <rfc-id> approve|reject|abstain "reason"`.
- Roles inspect RFC results with `.multi-agent/scripts/agentctl rfc-status <rfc-id>`.
- Decision ownership is project-defined.
- A technical lead role should own technical decision text when the project defines one.
- A product owner role should approve scope or user behavior impact when the project defines one.
- Accepted decisions must be summarized in `state/decisions.md`.
