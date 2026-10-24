# Event Ordering Analysis

How the AWS-Native Loan Originations system preserves (and in some places fails to
preserve) the order of events. Derived from the source in
[`src/domain/events.ts`](../src/domain/events.ts),
[`src/domain/aggregate.ts`](../src/domain/aggregate.ts),
[`src/commands/handler.ts`](../src/commands/handler.ts),
[`src/projector/handler.ts`](../src/projector/handler.ts), and the CDK stacks in
[`infra/stacks/`](../infra/stacks/).

Ordering is handled at three distinct levels, with different guarantees at each.

---

## 1. Ordering within a single aggregate — strong guarantee

Each event carries an explicit, monotonically increasing `version` scoped per
`aggregateId` (see `createEvent` in `src/domain/events.ts`). The DynamoDB event store
uses `aggregateId` as the partition key and `version` as the sort key
(`infra/stacks/global-stack.ts`). That composite key is the backbone of ordering.

### Writes are serialized by optimistic concurrency

`persistEvent` in `src/commands/handler.ts` issues a conditional write:

```ts
ConditionExpression: 'attribute_not_exists(aggregateId) AND attribute_not_exists(version)'
```

The command handler first replays all prior events, computes
`nextVersion = state.version + 1`, and commits only if that `(aggregateId, version)`
slot is still empty. Two concurrent commands on the same loan race for the same version
number; exactly one wins and the other's condition fails. This prevents version gaps and
duplicate versions.

### Reads come back in order

`loadEvents` queries with `ScanIndexForward: true`, returning events oldest-first by
`version`. `rehydrate` in `src/domain/aggregate.ts` folds them in that order to rebuild
state (`state = f(events)`). Ordering is deterministic because it is driven by the
`version` sort key, not by wall-clock time.

### Timestamps are metadata, not ordering

`timestamp` is `new Date().toISOString()` captured at event creation. It is **not** the
ordering key and must not be used as one — wall-clock time is unreliable for ordering due
to clock skew and same-millisecond events. `version` is the authoritative sequence.

---

## 2. Projection into Redis — weak spot

The read model is built by the Projector Lambda, and this is where ordering is most
fragile.

### Primary region path

DynamoDB Streams → Projector Lambda. DynamoDB Streams preserve order **per partition key**
(per `aggregateId`), and the Lambda event-source mapping processes a shard's records
sequentially. So for a single loan, `SUBMITTED → APPROVED → DISBURSED` arrive in order.

### The hazard: read-modify-write with silent drop

The event source is configured with `batchSize: 25` and `bisectBatchOnError: true`
(`infra/stacks/regional-stack.ts`). The projector handlers for `APPROVED`, `REJECTED`,
and `DISBURSED` perform a read-modify-write against Redis (`GET` then `SET`) and early
return when the loan is not yet present:

```ts
const existing = await client.get(`loan:${loanId}`);
if (!existing) return;   // <-- silently drops the update
```

If an out-of-order or retried batch delivers `APPROVED` before `SUBMITTED` has landed in
Redis, the approval is silently discarded. On stream processing failures, records retry
and can reorder across batch boundaries, so this is not purely theoretical.

### Kinesis path

`publishToKinesis` uses `PartitionKey: aggregateId`, so all events for one loan land on
the same shard and remain ordered for downstream consumers — the same per-aggregate
guarantee as DynamoDB Streams.

---

## 3. Cross-region ordering — no global guarantee

With DynamoDB Global Tables in active-active mode, both regions can write events for the
same aggregate. The optimistic-concurrency `version` check is evaluated against the
**local region replica**, so two regions can each believe they are writing `version: N`
for the same loan.

Global Tables resolve conflicts with **last-writer-wins at the item level**. A concurrent
same-version write in two regions can therefore silently clobber one event. There is no
global total order across regions.

The `demo.sh` cross-region scenario appears consistent only because it writes
sequentially with `sleep` between steps, allowing replication (typically <1s) to settle
before the next write.

---

## Summary of guarantees

| Scope | Mechanism | Guarantee |
|-------|-----------|-----------|
| Single aggregate, write | `version` sort key + conditional put | Strong — no gaps, no duplicates |
| Single aggregate, read/replay | `ScanIndexForward: true` | Strong — deterministic oldest-first |
| Projection to Redis (primary) | DynamoDB Streams, per-partition order | Conditional — breaks on retry/reorder due to silent early-return |
| Kinesis fan-out | `PartitionKey: aggregateId` | Strong per aggregate |
| Cross-region, same aggregate | Global Tables last-writer-wins | None — concurrent same-version writes can clobber |

---

## Recommended hardening

Ordered by value-to-risk ratio.

1. **Projector idempotency and reorder tolerance (highest value, lowest risk).**
   Stop early-returning on missing state. Track the last-applied `version` per loan in
   Redis and skip stale or duplicate stream records
   (`if incomingVersion <= appliedVersion: skip`). Alternatively, have each projection
   reconstruct from the full event history rather than incrementally mutating Redis. This
   makes the read model safe against retries and reordering.

2. **Cross-region write safety.** For correct active-active behavior, either:
   - pin each aggregate to a home region for writes (route commands by `aggregateId`), or
   - add conflict-aware write handling so same-version writes in two regions do not
     silently clobber each other.
   Last-writer-wins on same-version events is a correctness bug for concurrent writes to
   the same loan, not merely a latency concern.

3. **Secondary-region projector wiring.** The secondary region's DynamoDB Stream event
   source is configured post-deploy via the AWS CLI, not in CDK (see the comment in
   `regional-stack.ts`). Until that is done, the `us-west-2` read model is not updated
   from its local stream.
