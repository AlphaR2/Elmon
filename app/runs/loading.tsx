import { ListSkeleton, PageHeaderSkeleton } from "../components/skeletons";

export default function Loading() {
  return (
    <div className="space-y-4">
      <PageHeaderSkeleton />
      <ListSkeleton rows={6} />
    </div>
  );
}
