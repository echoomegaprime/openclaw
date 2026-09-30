import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../kysely-sync.js";
import { encodeMessageControlAdmission } from "./message-control-operation.identity.js";
import type {
  MessageControlAdmission,
  MessageControlAdmissionResult,
  MessageControlAttempt,
  MessageControlDisposition,
  MessageControlLocator,
  MessageControlRecord,
} from "./message-control-operation.types.js";

type Tables = Pick<OpenClawStateKyselyDatabase, "channel_control_operations">;
type Row = Selectable<Tables["channel_control_operations"]>;
const sql = (db: DatabaseSync) => getNodeSqliteKysely<Tables>(db);
function invalidStored(): never {
  throw new Error("Invalid message-control stored record");
}
function storedObject(json: string, keys: string[]): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join("|") !== keys.toSorted().join("|")
  ) {
    return invalidStored();
  }
  // SAFETY: parsed JSON passed the non-array object and exact-own-key guards; values stay unknown.
  return value as Record<string, unknown>;
}
function storedTime(value: unknown, row: Row): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < row.created_at_ms ||
    value > row.updated_at_ms
  ) {
    return invalidStored();
  }
  return value;
}
function storedResult(row: Row): MessageControlRecord["result"] {
  if (row.result_json === null) {
    return null;
  }
  const value = storedObject(row.result_json, ["disposition", "at", "atomicCas"]);
  const disposition = value.disposition;
  if (
    (disposition !== "not_entered" &&
      disposition !== "rejected" &&
      disposition !== "conflict" &&
      disposition !== "noop" &&
      disposition !== "verified_updated" &&
      disposition !== "unknown") ||
    value.atomicCas !== false
  ) {
    return invalidStored();
  }
  return { disposition, at: storedTime(value.at, row), atomicCas: false };
}
function storedObservation(row: Row): MessageControlRecord["observation"] {
  if (row.observation_json === null) {
    return null;
  }
  const value = storedObject(row.observation_json, ["value", "at"]);
  if (value.value !== 0 && value.value !== 1 && value.value !== 2) {
    return invalidStored();
  }
  return { value: value.value, at: storedTime(value.at, row) };
}
function decode(row: Row): MessageControlRecord {
  // SAFETY: encodeMessageControlAdmission below validates every closed stable field before any use or return.
  const stable = JSON.parse(row.stable_json) as MessageControlRecord["stable"];
  // SAFETY: the same encoder validates every execution field; canonical bytes and row bindings must then match.
  const execution = JSON.parse(row.execution_json) as MessageControlRecord["execution"];
  const encoded = encodeMessageControlAdmission({
    stable,
    execution,
    key: row.request_key,
    operationId: row.operation_id,
    attemptId: row.attempt_id,
  });
  if (
    encoded.stableJson !== row.stable_json ||
    encoded.executionJson !== row.execution_json ||
    encoded.digest !== row.stable_digest ||
    encoded.namespace !== row.namespace ||
    encoded.resourceKey !== row.resource_key
  ) {
    throw new Error("Invalid message-control stored binding");
  }
  const phase = row.phase;
  if (
    (phase !== "prepared" &&
      phase !== "dispatching" &&
      phase !== "settled" &&
      phase !== "unknown") ||
    (row.held !== 0 && row.held !== 1) ||
    (row.cancel_requested !== 0 && row.cancel_requested !== 1) ||
    row.created_at_ms !== execution.admittedAtMs ||
    !Number.isSafeInteger(row.updated_at_ms) ||
    row.updated_at_ms < row.created_at_ms
  ) {
    return invalidStored();
  }
  const result = storedResult(row);
  const observation = storedObservation(row);
  if (
    (row.held === 1) !== (phase !== "settled") ||
    ((phase === "prepared" || phase === "dispatching") && result !== null) ||
    (phase === "settled" && (!result || result.disposition === "unknown")) ||
    (phase === "unknown" && result?.disposition !== "unknown")
  ) {
    return invalidStored();
  }
  return {
    operationId: row.operation_id,
    attemptId: row.attempt_id,
    namespace: row.namespace,
    key: row.request_key,
    stable,
    execution,
    phase,
    held: row.held === 1,
    result,
    observation,
    cancelRequested: row.cancel_requested === 1,
  };
}
export function readMessageControlOperation(
  db: DatabaseSync,
  input: MessageControlLocator,
): MessageControlRecord | null {
  if (!tableExists(db, "channel_control_operations")) {
    return null;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("channel_control_operations")
      .selectAll()
      .where("operation_id", "=", input.operationId)
      .where("namespace", "=", input.namespace),
  );
  return row ? decode(row) : null;
}
export function admitMessageControlOperation(
  db: DatabaseSync,
  input: MessageControlAdmission,
): MessageControlAdmissionResult {
  const binding = encodeMessageControlAdmission(input);
  const prior = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("channel_control_operations")
      .selectAll()
      .where("namespace", "=", binding.namespace)
      .where("request_key", "=", input.key),
  );
  if (prior) {
    const record = decode(prior);
    return prior.stable_digest === binding.digest && prior.stable_json === binding.stableJson
      ? { disposition: "receipt", record }
      : { disposition: "conflict" };
  }
  const held = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("channel_control_operations")
      .select("operation_id")
      .where("resource_key", "=", binding.resourceKey)
      .where("held", "=", 1),
  );
  if (held) {
    return { disposition: "held" };
  }
  const count = executeSqliteQueryTakeFirstSync(
    db,
    sql(db)
      .selectFrom("channel_control_operations")
      .select(({ fn }) => fn.countAll<number>().as("count")),
  );
  if ((count?.count ?? 0) >= 4096) {
    return { disposition: "capacity" };
  }
  executeSqliteQuerySync(
    db,
    sql(db).insertInto("channel_control_operations").values({
      operation_id: input.operationId,
      namespace: binding.namespace,
      request_key: input.key,
      attempt_id: input.attemptId,
      stable_json: binding.stableJson,
      stable_digest: binding.digest,
      execution_json: binding.executionJson,
      resource_key: binding.resourceKey,
      phase: "prepared",
      held: 1,
      result_json: null,
      observation_json: null,
      cancel_requested: 0,
      created_at_ms: input.execution.admittedAtMs,
      updated_at_ms: input.execution.admittedAtMs,
    }),
  );
  return {
    disposition: "admitted",
    record: readMessageControlOperation(db, {
      namespace: binding.namespace,
      operationId: input.operationId,
    })!,
  };
}
function attempt(db: DatabaseSync, input: MessageControlAttempt) {
  const record = readMessageControlOperation(db, input);
  if (
    !record ||
    record.attemptId !== input.attemptId ||
    !Number.isSafeInteger(input.now) ||
    input.now < record.execution.admittedAtMs
  ) {
    throw new Error("Message-control attempt identity mismatch");
  }
  return record;
}
export function markMessageControlDispatched(db: DatabaseSync, input: MessageControlAttempt) {
  const record = attempt(db, input);
  if (record.phase !== "prepared" || record.cancelRequested) {
    throw new Error("Invalid message-control dispatch transition");
  }
  executeSqliteQuerySync(
    db,
    sql(db)
      .updateTable("channel_control_operations")
      .set({ phase: "dispatching", updated_at_ms: input.now })
      .where("operation_id", "=", input.operationId)
      .where("attempt_id", "=", input.attemptId),
  );
  return readMessageControlOperation(db, input)!;
}
export function settleMessageControlOperation(
  db: DatabaseSync,
  input: MessageControlAttempt & { disposition: MessageControlDisposition },
) {
  const record = attempt(db, input);
  const allowed =
    record.phase === "prepared"
      ? ["not_entered", "conflict", "noop"]
      : record.phase === "dispatching"
        ? ["not_entered", "rejected", "verified_updated", "unknown"]
        : [];
  if (!allowed.includes(input.disposition)) {
    throw new Error("Invalid message-control settlement transition");
  }
  executeSqliteQuerySync(
    db,
    sql(db)
      .updateTable("channel_control_operations")
      .set({
        phase: input.disposition === "unknown" ? "unknown" : "settled",
        held: input.disposition === "unknown" ? 1 : 0,
        result_json: JSON.stringify({
          disposition: input.disposition,
          at: input.now,
          atomicCas: false,
        }),
        updated_at_ms: input.now,
      })
      .where("operation_id", "=", input.operationId)
      .where("attempt_id", "=", input.attemptId),
  );
  return readMessageControlOperation(db, input)!;
}
export function observeMessageControlOperation(
  db: DatabaseSync,
  input: MessageControlLocator & { value: 0 | 1 | 2; now: number },
) {
  const record = readMessageControlOperation(db, input);
  if (!record) {
    return null;
  }
  if (
    ![0, 1, 2].includes(input.value) ||
    !Number.isSafeInteger(input.now) ||
    input.now < record.execution.admittedAtMs
  ) {
    throw new Error("Invalid message-control observation");
  }
  executeSqliteQuerySync(
    db,
    sql(db)
      .updateTable("channel_control_operations")
      .set({
        observation_json: JSON.stringify({ value: input.value, at: input.now }),
        updated_at_ms: input.now,
      })
      .where("operation_id", "=", input.operationId)
      .where("namespace", "=", input.namespace),
  );
  return readMessageControlOperation(db, input);
}
export function cancelMessageControlOperation(db: DatabaseSync, input: MessageControlLocator) {
  const record = readMessageControlOperation(db, input);
  if (!record) {
    return null;
  }
  executeSqliteQuerySync(
    db,
    sql(db)
      .updateTable("channel_control_operations")
      .set({ cancel_requested: 1 })
      .where("operation_id", "=", input.operationId)
      .where("namespace", "=", input.namespace),
  );
  return readMessageControlOperation(db, input);
}
