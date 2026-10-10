#!/usr/bin/env bash
# Cut the nine scrubbed fixtures listed in docs/implementation-plan-v2.md §2
# from the real transcripts on this machine. Re-runnable. Review the output
# with `git diff fixtures/` before committing.
set -euo pipefail
cd "$(dirname "$0")/.."

P="$HOME/.claude/projects"
MK="bun run scripts/make-fixture.ts"
R2="$P/-Users-tobylee-workspace-work-bmx-bzflow2/b7a3fc04-de70-4c43-adc1-1d041c43c567.jsonl"
BG="$P/-Users-tobylee-workspace-work-bmx-bzflow/253aaf04-fe1a-4d97-b8eb-87ee6b61659f.jsonl"
CP="$P/-Users-tobylee-workspace-work-bmx-bzflow/e1cd2912-6033-4ef6-8de0-4f97d4978041.jsonl"
LK="$P/-Users-tobylee-workspace-work-bmx-bzflow/f63f1f68-fbdd-431b-83e4-4b8fb3cc78d9.jsonl"
KT="$P/-Users-tobylee-workspace-sandbox-kotlin/7fe32363-515c-4a1b-b09d-c62eb5ccacf4.jsonl"
ER="$P/-Users-tobylee-workspace-sandbox-laurentang/1b993a23-0a71-4f76-85f2-dde383c94c46.jsonl"
CO="$P/-Users-tobylee-workspace-ai-book-writer/4b11f8bf-b7ff-4d17-8731-fa592d9004e0.jsonl"

rm -rf fixtures
mkdir -p fixtures/registry

# recap-basic: two full turns, ending with the first away_summary (line 213)
$MK "$R2" --out fixtures/recap-basic.jsonl --to-line 213 \
  --keep 762eb087-a6da-409b-9f55-5947452e2f85,13969395-01cb-4d57-9179-96f8b02d8d01 \
  --keep-msg msg_011CfsqkAy8H2tJKPnokNzYh,msg_011Cfsr7dZN5HMtVDQ5LsjEE

# multiblock: one message on 3 lines (27-29) + the 2-line end_turn message (181-182)
$MK "$R2" --out fixtures/multiblock.jsonl --to-line 30 \
  --keep-msg msg_011CfsqkAy8H2tJKPnokNzYh,msg_011Cfsr7dZN5HMtVDQ5LsjEE
$MK "$R2" --out fixtures/multiblock.jsonl --append --from-line 178 --to-line 186 \
  --keep-msg msg_011CfsqkAy8H2tJKPnokNzYh,msg_011Cfsr7dZN5HMtVDQ5LsjEE

# turn-open: cut after the third prompt's first tool call (line 230), no turn_duration follows
$MK "$R2" --out fixtures/turn-open.jsonl --to-line 230 \
  --keep 762eb087-a6da-409b-9f55-5947452e2f85,13969395-01cb-4d57-9179-96f8b02d8d01 \
  --keep-msg msg_011CfsspUuyDFnzhvKh9q23g

# background: the whole session (async agents, background bash, queue ops, one denial)
$MK "$BG" --out fixtures/background.jsonl \
  --keep 62e7726c-a341-45df-93c7-86c1883764bc,f05f4c95-aec0-4695-a96e-3a9c4c27986a,de543f24-7d34-458b-946e-f9fcc5526a8b,f6fcaef3-d5eb-447e-b627-fba7c7d57783,d34c6963-64fd-4be9-b802-18646cd2c8a0,26c84210-3f8e-4f1e-99ad-f323b1e39016,36f41c4f-446e-463a-8cfd-d11b283bf588,5fb3901e-22e6-40bb-ac0f-95b47cdac557

# compaction: head (bridge_status) + windows around the two compact_boundary entries
$MK "$CP" --out fixtures/compaction.jsonl --to-line 12
$MK "$CP" --out fixtures/compaction.jsonl --append --from-line 1858 --to-line 1866
$MK "$CP" --out fixtures/compaction.jsonl --append --from-line 3691 --to-line 3699

# links: pr-link from bzflow + custom-title/agent-name/frame-link from the Desktop kotlin session
$MK "$LK" --out fixtures/links.jsonl --types pr-link,assistant --max-per-type 2
$MK "$KT" --out fixtures/links.jsonl --append --types custom-title,agent-name,frame-link,ai-title,assistant --max-per-type 3

# cost: cost-state entries (+2 assistant lines for the model)
$MK "$CO" --out fixtures/cost.jsonl --types cost-state,assistant --max-per-type 2

# errors: head of the session that holds the synthetic 403 error line (line 26)
$MK "$ER" --out fixtures/errors.jsonl --to-line 30

# registry: copies of sessions/*.json with dead PIDs; .key files are never read
i=0
for f in "$HOME"/.claude/sessions/*.json; do
  i=$((i+1)); pid=$((999900+i))
  jq --argjson pid "$pid" '.pid=$pid | .messagingSocketPath="/tmp/cc-socks/\($pid).sock"' "$f" \
    | sed -e "s#/Users/$USER#/Users/dev#g; s#$USER#dev#g" > "fixtures/registry/$pid.json"
done

echo
echo "== privacy checks (every count must be 0)"
grep -c "$USER" fixtures/*.jsonl fixtures/registry/*.json || true
grep -c -E 'prompt_snapshot|credential_org|serverClassifier|wireToolInputs' fixtures/*.jsonl || true
echo "== sizes"
du -sh fixtures/*.jsonl
