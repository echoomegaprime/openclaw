import type {
  ChannelIngressQueueEnqueueResult,
  ChannelIngressQueuePruneOptions,
} from "./ingress-queue.js";

export type IngressEnqueueInput = {
  queueName: string;
  eventId: string;
  channelId: string;
  accountId: string;
  payloadJson: string;
  metadataJson: string | null;
  laneKey?: string;
  receivedAt: number;
  updatedAt: number;
};
export type IngressPruneInput = Omit<ChannelIngressQueuePruneOptions, "protectIds" | "now"> & {
  queueName: string;
  protectIds: string[];
  now: number;
};
export type IngressWorkerOperations = {
  "ingress.enqueue": {
    input: IngressEnqueueInput;
    output: ChannelIngressQueueEnqueueResult<unknown, unknown, unknown>;
  };
  "ingress.prune": { input: IngressPruneInput; output: number };
};
