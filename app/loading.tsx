import { ListSkeleton, PageHeaderSkeleton, Skeleton } from "./components/skeletons";

// Default for any page: header, a block and a list.
export default function Loading() {
  return (
    <div className="space-y-5">
      <PageHeaderSkeleton />
      <Skeleton className="h-56 w-full rounded-xl" />
      <ListSkeleton rows={4} />
    </div>
  );
}
