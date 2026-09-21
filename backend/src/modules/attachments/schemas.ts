import { z } from 'zod';

/**
 * Attachment input for a ward bulletin or an event.
 *
 * A file attachment (photo / video / document) carries a base64 data-url that is
 * run through the shared media pipeline; a `link` carries a URL only. The kind
 * drives which field is required, so a caller can never post a link row with a
 * stray data-url or vice-versa.
 */
export const attachmentKind = z.enum(['photo', 'video', 'document', 'link']);
export type AttachmentKind = z.infer<typeof attachmentKind>;

const dataUrl = z.string().min(16).max(8 * 1024 * 1024);

export const createAttachmentSchema = z.discriminatedUnion('kind', [
  z.object({
    parentType: z.enum(['bulletin', 'event']),
    parentId: z.string().uuid(),
    kind: z.enum(['photo', 'video', 'document']),
    dataUrl,
    title: z.string().max(160).optional(),
    caption: z.string().max(500).optional(),
  }),
  z.object({
    parentType: z.enum(['bulletin', 'event']),
    parentId: z.string().uuid(),
    kind: z.literal('link'),
    url: z.string().url().max(2048).refine(
      (u) => /^https?:\/\//i.test(u),
      { message: 'Link must be an http(s) URL' },
    ),
    title: z.string().max(160).optional(),
    caption: z.string().max(500).optional(),
  }),
]);
export type CreateAttachment = z.infer<typeof createAttachmentSchema>;

export const listAttachmentsQuery = z.object({
  parentType: z.enum(['bulletin', 'event']),
  parentId: z.string().uuid(),
});
export type ListAttachmentsQuery = z.infer<typeof listAttachmentsQuery>;
