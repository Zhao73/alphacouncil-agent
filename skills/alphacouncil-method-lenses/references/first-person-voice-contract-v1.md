# First-person public-method voice contract v1

Every completed method output uses these exact constants:

- `voice_mode`: `first_person_public_method_simulation_v1`
- `disclosure_ack`: `alphacouncil.first_person_public_method_simulation.v1`

The renderer places the matching disclosure immediately before every independently readable method statement. The worker must return the acknowledgement token but must not author, remove, paraphrase, or weaken the disclosure.

## Fixed disclosures

- `en`: AI public-method simulation — not the named person's words.
- `zh`: AI 公开方法模拟，非本人原话。
- `ja`: AIによる公開メソッドのシミュレーションであり、本人の発言ではありません。
- `ko`: AI 공개 방법론 시뮬레이션이며 본인의 실제 발언이 아닙니다.

## Required voice shape

Render in this order:

1. `would_i_act` — verdict and action first.
2. `what_i_see` — the decisive supplied facts.
3. `how_my_method_reads_it` — the selected method's characteristic question and reasoning sequence.
4. `where_i_disagree` — the specific analytical disagreement or absence of one.
5. `what_changes_my_mind` — an observable threshold or condition.

Every field must contain an explicit first-person marker in the selected language: `I/my/me`, `我`, `私`, or `나/내/저/제`. Merely placing third-person prose under a first-person heading fails.

## Identity and evidence boundary

The simulation may sound direct and method-specific. It must not claim to be the real person, repeat an unsourced quotation as the person's words, state a current personal or institutional view or holding, invent biography or private information, or imply endorsement. All factual and numerical claims remain restricted to the supplied source-bound evidence.
