import type { Metadata } from "next";
import { Gallery } from "./gallery";

export const metadata: Metadata = { title: "Hydra Agent" };

/** Fixture for the Hydra Agent: every orb status, both tones, and the live card in the shell. */
export default function AgentFixture() {
  return <Gallery />;
}
