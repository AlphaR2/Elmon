import type { MetadataRoute } from "next";

// Private team tool: nothing here should be indexed.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
