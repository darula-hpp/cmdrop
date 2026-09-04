import fs from "node:fs/promises";
import { inboxPath, OFFER_TTL_MS } from "../paths.js";
import type { CommandPayload, InboxOffer } from "../protocol/types.js";

export class Inbox {
  private offers: InboxOffer[] = [];
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(inboxPath(), "utf8");
      this.offers = (JSON.parse(raw) as InboxOffer[]) ?? [];
    } catch {
      this.offers = [];
    }
    this.loaded = true;
    this.prune();
  }

  private async persist(): Promise<void> {
    await fs.writeFile(inboxPath(), JSON.stringify(this.offers, null, 2), { mode: 0o600 });
  }

  prune(): void {
    const now = Date.now();
    this.offers = this.offers.filter((o) => Date.parse(o.expiresAt) > now);
  }

  async add(payload: CommandPayload): Promise<InboxOffer> {
    await this.load();
    this.prune();
    const offer: InboxOffer = {
      payload,
      receivedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + OFFER_TTL_MS).toISOString(),
    };
    this.offers = this.offers.filter((o) => o.payload.id !== payload.id);
    this.offers.unshift(offer);
    await this.persist();
    return offer;
  }

  async list(): Promise<InboxOffer[]> {
    await this.load();
    this.prune();
    return [...this.offers];
  }

  async get(id: string): Promise<InboxOffer | undefined> {
    await this.load();
    this.prune();
    return this.offers.find((o) => o.payload.id === id);
  }

  async remove(id: string): Promise<InboxOffer | undefined> {
    await this.load();
    const found = this.offers.find((o) => o.payload.id === id);
    this.offers = this.offers.filter((o) => o.payload.id !== id);
    await this.persist();
    return found;
  }
}
