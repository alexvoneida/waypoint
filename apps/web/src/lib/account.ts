import { z } from "zod";

// A handle is a URL segment: it is what `/@handle` and every `/e/:handle/:slug`
// under it are built from. Unrestricted text passes the database's citext
// uniqueness check and still breaks routing -- a handle containing "/" invents
// a path segment, and one containing "%" or "#" changes what the browser sends.
// Restricting the character set here is cheaper than escaping at every place a
// handle is interpolated into a path.
export const handleSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/, {
    message:
      "Use lowercase letters, digits, hyphens and underscores; start and end with a letter or digit",
  });

export const visibilitySchema = z.enum(["public", "private"]);

export type Visibility = z.infer<typeof visibilitySchema>;
