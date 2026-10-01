import { Suspense } from "react";
import { RunView } from "./RunView";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <RunView id={Number(id)} />
    </Suspense>
  );
}
