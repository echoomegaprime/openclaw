import type {
  MessageControlAdmission,
  MessageControlAdmissionResult,
  MessageControlAttempt,
  MessageControlDisposition,
  MessageControlLocator,
  MessageControlRecord,
} from "./message-control-operation.types.js";

export type MessageControlWorkerOperations = {
  "messageControl.admit": { input: MessageControlAdmission; output: MessageControlAdmissionResult };
  "messageControl.dispatch": { input: MessageControlAttempt; output: MessageControlRecord };
  "messageControl.settle": {
    input: MessageControlAttempt & { disposition: MessageControlDisposition };
    output: MessageControlRecord;
  };
  "messageControl.observe": {
    input: MessageControlLocator & { value: 0 | 1 | 2; now: number };
    output: MessageControlRecord | null;
  };
  "messageControl.cancel": { input: MessageControlLocator; output: MessageControlRecord | null };
};
