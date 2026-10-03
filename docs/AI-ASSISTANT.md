# Grady, the assistant: how answers and actions are kept correct

Grady is the chat assistant in the staff application and the customer portal. This page explains the design that makes its figures exact and its actions safe, and why the platform does **not** let the model write SQL.

## The problem this design solves

"How many tickets are open?" used to get a different answer each time. Three things caused it: the model could choose between two overlapping tools (a list that returned 20 rows plus a total, and a statistics tool that returned a dozen figures) and read different numbers from them; it was free to count rows itself; and it was sampled at a non-zero temperature, so the same question did not produce the same tool calls. None of that is fixed by a better prompt alone.

## What the research says

- **Text-to-SQL is for analytics over a warehouse, not for an operational system with permissions and actions.** Letting a model generate SQL against production tables needs a parser, a catalog binder, a statement classifier, a permission check and an audit record after every generation, and even then row-level security is bypassed whenever the model runs as a service account ([dpriver: why enterprises should not let LLMs execute SQL directly](https://www.dpriver.com/blog/?p=3232), [text-to-SQL security risks](https://www.dpriver.com/blog/text-to-sql-security-10-risks-before-production-deployment/), [AWS: multi-tenant LLM analytics with row-level security](https://aws.amazon.com/blogs/machine-learning/multi-tenant-llm-analytics-with-row-level-security-how-we-built-a-secure-agent-on-aws/)). The cases where text-to-SQL shines are ad-hoc joins and conditional aggregations over a read-only replica ([text-to-SQL practical guide](https://www.puppygraph.com/blog/text-to-sql-llm), [LLM database integration patterns](https://myengineeringpath.dev/programming/python/llm-database-integration/)).
- **A semantic layer beats raw SQL for consistent numbers.** When the model queries governed definitions ("open means new, in progress or pending") instead of raw tables, results are consistent and auditable; a 2026 study measured 17 to 23 percentage points better analytical pass rates with a semantic layer across three frontier models ([GROUND: governed semantic definitions](https://arxiv.org/pdf/2608.26157), [your data agent needs one definition of revenue](https://tianpan.co/blog/2026/07/02/your-data-agent-needs-one-definition-of-revenue), [semantic layer for AI](https://www.knowi.com/blog/semantic-layer-for-ai/)).
- **Tool calls and structured outputs run at temperature 0.** That is the consensus for agent code paths; creativity belongs elsewhere ([temperature and sampling for agents](https://blckalpaca.at/en/knowledge-base/ai-agents/llm-fundamentals-for-agents/temperatur-und-sampling-fuer-agenten), [why your LLM gives different answers every time](https://sia.hackernoon.com/the-builders-dilemma-balancing-creativity-and-consistency-in-agentic-workflows)).
- **Side effects are propose-then-commit.** Persist the proposed action with an idempotency key, show the user exactly what will happen, run it only after a positive acknowledgement, exactly once, and record it ([human-in-the-loop: propose-then-commit](https://learn.traeai.com/t/ai-engineering/phases/15-autonomous-systems/15-propose-then-commit.html), [agents need transaction boundaries](https://urandom.io/blog/2026-04-07-agents-need-transaction-boundaries-not-bigger-prompts)).

## What Progression does

**1. One semantic query tool, same predicates as the screen.** All questions about tickets go through `query_tickets` with a small typed input: a mode (`count`, `breakdown`, `list`), a lifecycle bucket (`open` by default, `all`, `resolved`, `awaiting_customer`, …), filters (type, priority, customer, engineer, team, service, site, scope, SLA state, dates, words) and a `groupBy` for breakdowns. The server resolves names to ids within the caller's visibility, runs the **same predicates the ticket list uses**, and returns one exact `total`, a plain-language `definition` of what was counted, and `facts` lines such as `76 open tickets (new, in progress or pending) for Sample Customer`. The model never counts rows and never sees SQL. The two tools that overlapped with it are no longer offered to the model (they remain callable for stored conversations).

**2. Deterministic sampling.** Every call in the chat loop runs at temperature 0, so the same question produces the same tool call and the same wording.

**3. Grounded answers.** The loop collects the `facts` of every tool result in the turn. If the model's reply does not state at least one of those figures, the facts are placed first, in bold, so the user always reads the system's number. Replies that quote the figure are left untouched. The prompt also requires every number to be copied from a facts line together with its definition.

**4. Propose-then-commit for actions.** When the model calls an action tool (create ticket, add comment, assign, set status, link), nothing runs. The platform resolves a preview against real records ("Assign INC-001234 ("Core switch down") to Priya Sharma"), stores it on the conversation as the pending action, and the model asks "Shall I proceed?". The next message decides: a plain yes commits it (the platform executes it exactly once, without consulting the model, and replies "Done: …" with the link), a no drops it, anything else drops it and tells the model so it can propose again with the new details. One pending action at a time; it expires after 30 minutes; a second yes cannot run it twice. The chat window shows the held preview with Yes / No buttons driven by the server's state, not by reading the reply's wording.

**4a. Incident command.** The `major_incidents` read tool answers "which major incidents are open, who commands them and which stakeholder update is overdue" from the same rows as the Operations page, and `POST /ai/tickets/:id/major/draft-update` drafts a stakeholder update (customer tone) or a bridge note (internal tone) from the incident record, the communication log and the latest notes; the person reads and edits it before it is sent, and the draft is stored as a suggestion like the other drafts.

**5. Tenant isolation stays underneath all of this** (see "Customer data isolation" in OPERATIONS.md): row-level security, explicit own-customer predicates, the tool-result fence and the answer fence for portal users.

## Checking it

`apps/api/test/ai-grounding.test.ts` covers exact counts and breakdowns against known fixtures, portal pinning, identical stored answers for three identical questions, the facts-first fallback, temperature 0, and the full propose / confirm / cancel / other-message flow including the exactly-once guarantee. `apps/api/test/ai-isolation.test.ts` covers the tenant fences.

## Extending it

Add a new read capability as a tool that returns `facts` for anything numeric; add a new side effect as an action tool with a `preview`. Do not add a tool that overlaps an existing one: overlap is what made counts drift.
