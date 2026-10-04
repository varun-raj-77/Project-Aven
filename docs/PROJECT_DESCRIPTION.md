# Project description

## Source precedence

1. The current task: AVEN-001 only, with no app/package implementation.
2. [Master Project Description, prepared 2026-10-03](sources/AVEN_MASTER_PROJECT_DESCRIPTION_2026-10-03.pdf).
3. [Implementation instructions](<sources/AVEN — IMPLEMENTATION INSTRUCTIONS.txt>).

The source files are preserved byte-for-byte; hashes are recorded in
[the inspection report](REPOSITORY_INSPECTION.md). This document is an
implementation summary, not a replacement for reading the sources. Earlier
project-selection documents are historical. Build Aven v0.1; do not reopen
selection without a concrete fatal problem revealed by implementation.

## Mission and research question

Build a neutral, owner-agnostic, local-first personal AI agent that becomes more
useful to one owner through evidence-backed learning. The owner relationship
should survive sessions, tasks, and foundation-model changes. Aven adapts to the
owner; adaptation must remain inspectable, scoped, reversible, evidence-backed,
and permissioned.

The immediate objective is an experiment, not the complete product: can governed
persistent learning improve owner-specific task performance over a strong naive
personalization baseline while authority remains fixed outside the model?

## Locked architecture

```text
OWNER
  -> FAST LOOP
     intent -> context -> plan -> policy -> execution -> verification -> response
  -> EXPERIENCE LEDGER (append-only canonical evidence)
  -> SLOW LOOP
     observation -> hypothesis -> evidence/counterexamples -> historical replay
     -> held-out evaluation -> independent evaluation/risk classification
     -> promotion / shadow / rejection -> monitoring / rollback

ROOT: external authority over policy, execution permissions, eval vault,
      promotion, trusted versions, audit integrity, and rollback throughout.
```

The fast loop helps now and can apply explicit session corrections without
quietly rewriting durable behavior. The slow loop proposes evaluated, scoped
learning. Facts, preferences, episodes, intent patterns, procedures, and active
task state are distinct owner-state types. Durable items require source, scope,
confidence, evidence/counterexamples, timestamps, model/version, status, and
supersession links. The Context Broker assembles relevant context; it does not
dump all memory into a prompt.

Root returns ALLOW, DENY, or REQUIRE_OWNER_APPROVAL for typed proposals. Aven
cannot alter Root, grant itself permissions, or promote its own output. External
files, webpages, tool responses, and predicted intent cannot grant authority.
Exact approval binding, process isolation, and vault controls need later
implementation.

## v0.1 experiment and current milestone

Compare A: same model without persistent state; B: same model with an editable
scoped profile and searchable interaction history; C: ledger, typed/scoped owner
state, corrections, provenance, and evaluated promotion. C must beat B, not just
A, without increased control failures or excessive supervision.

The eventual demo must show a correction, immediate session effect, preserved
evidence, narrow candidate, replay/counterexamples, controlled
promotion/shadow/rejection, correct application to unseen matching cases,
correct non-application elsewhere, model-swap continuity, evidence-based
explanation, and a bounded action decision. The outreach example in the source
is illustrative; it is not an actual owner preference.

**AVEN-001 delivers only documentation, repository structure, tooling, and a
draft experiment manifest.** No runtime is implemented. SQLite is preferred
initially; schemas, providers, frameworks, scope representation, evaluator
design, and Root process topology remain unresolved. Local-first does not
automatically mean offline.

## Scope and evidence limits

No voice, telephony, restaurant calling, production email, real purchases,
unrestricted browser/computer control, swarms, affect/emotion/consciousness
architecture, self-preservation objectives, model fine-tuning, production
self-modification, integration catalog, billing, startup website, or cloud
scaling.

Aven Red and affect/self-model/evolution research are separate future contained
programs, not this experiment. Future adversarial research requires fake
accounts, money/infrastructure, no real credentials, no unrestricted egress, and
no production deployment. It is not implemented or authorized by this bootstrap.

Working numerical targets in the Master Description guide future studies; they
are not universal safety standards. EXP-001's proposed gates, freeze
requirements, and limitations are explicit in its protocol. No experimental
results exist.
