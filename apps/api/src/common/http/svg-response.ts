import type { FastifyReply } from 'fastify';

/**
 * Sends a server-generated SVG as a real document instead of the JSON envelope
 * (`API.md` §1.3). Callers own the body; the filename must never be raw request
 * input (UUID-validated route params only) because it reaches a response header.
 */
export function sendSvg(reply: FastifyReply, svg: string, filename: string): void {
  reply
    .type('image/svg+xml; charset=utf-8')
    .header('Content-Disposition', `inline; filename="${filename}"`)
    .send(svg);
}
