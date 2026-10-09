/** Exact serialized request presented at the selected transport's handoff. */
type DiscordPhysicalHandoffRequest = Readonly<{
  method: "PATCH";
  path: string;
  body: string;
}>;

/** Host-owned capability for the fixed media-filter write; never a wire option. */
export type DiscordPhysicalHandoff = Readonly<{
  assertCurrent: () => void;
  consumePhysicalHandoff: (request: DiscordPhysicalHandoffRequest) => void;
}>;

const synchronousFetches = new WeakSet<typeof fetch>();

/** Only the existing Discord proxy factory registers its synchronous SDK fetch. */
export function retainDiscordSynchronousFetch(fetchImpl: typeof fetch): typeof fetch {
  synchronousFetches.add(fetchImpl);
  return fetchImpl;
}

/** An arbitrary injected fetch cannot attest its own physical dispatch contract. */
export function isDiscordSynchronousFetch(fetchImpl: typeof fetch): boolean {
  return synchronousFetches.has(fetchImpl);
}
