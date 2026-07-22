import type { Metadata } from "next";
import { ReaderShell } from "./ReaderShell";

export const metadata: Metadata = {
  description: "现代、轻量、可自托管的 Reader 3 兼容阅读器。",
};

export default function Home() {
  return <ReaderShell />;
}
