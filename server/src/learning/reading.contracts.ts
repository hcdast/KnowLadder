import type { Document } from 'mongodb';

export interface ReadingPosition { kind: 'text_offset'; offset_utf16: number; }
export interface ReadingEventInput {
  event_type: 'reading_progress_set'; event_id: string; textbook_edition_id: string;
  chapter_id: string; edition_revision: number; expected_revision: number;
  position: ReadingPosition; completed: boolean;
}
export interface ReadingResult { event_id: string; progress_revision: number; server_received_at: string; }
export interface ReadingProgressDto {
  chapter_id: string; edition_revision: number; position: ReadingPosition | null;
  completed: boolean | null; progress_revision: number; updated_at: string | null;
}
export interface ReadingPage {
  textbook_edition_id: string; edition_revision: number; items: ReadingProgressDto[]; next_cursor: string | null;
}
export interface ReadingProgress extends Document {
  _id: string; org_id: string; member_id: string; chapter_id: string; edition_id: string;
  edition_revision: number; position: ReadingPosition | null; completed: boolean | null;
  revision: number; updated_at: Date; cleared_at: Date | null;
}
export interface ReadingEvent extends Document {
  _id: string; org_id: string; member_id: string; event_id: string; event_type: 'reading_progress_set';
  request_hash: string; chapter_id: string; edition_id: string; edition_revision: number;
  expected_revision: number; position: ReadingPosition; completed: boolean;
  server_received_at: Date; progress_revision: number;
}
