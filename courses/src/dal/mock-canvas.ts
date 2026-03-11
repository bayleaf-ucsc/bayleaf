/**
 * Mock Canvas DAL — canned data for development and testing
 *
 * The mock page body for any registered course echoes back whatever
 * claim code was stored, so the full claim-verify flow works locally.
 * Call injectClaimCode() after course registration to simulate a
 * teacher pasting the code onto their Canvas page.
 */

import type { CanvasDAL, CanvasCourseInfo, CanvasPageContent } from './types';

const MOCK_COURSES: Record<number, CanvasCourseInfo> = {
  85291: { id: 85291, name: 'CMPM 121 — Generative AI', course_code: 'CMPM 121' },
  85292: { id: 85292, name: 'CMPS 101 — Algorithms', course_code: 'CMPS 101' },
};

const DEFAULT_PROMPT = 'You are a helpful AI assistant for this course.';

// Shared mutable state: claim codes "pasted" onto mock Canvas pages
const claimCodes = new Map<number, string>();

/** Simulate a teacher pasting a claim code onto their Canvas page. */
export function injectClaimCode(courseId: number, code: string): void {
  claimCodes.set(courseId, code);
}

export function createMockCanvasDAL(): CanvasDAL {
  return {
    async getCourseInfo(courseId) {
      return MOCK_COURSES[courseId] ?? null;
    },

    async getPageByTitle(courseId, titleSlug) {
      if (titleSlug !== 'bayleaf-ai') return null;
      if (!MOCK_COURSES[courseId]) return null;

      // Build page body: include claim code if one was injected, plus a default prompt
      const code = claimCodes.get(courseId);
      const bodyParts: string[] = [];
      if (code) bodyParts.push(`<p>${code}</p>`);
      bodyParts.push(`<p>${DEFAULT_PROMPT}</p>`);

      return {
        title: 'BayLeaf AI',
        body: bodyParts.join(''),
        url: 'bayleaf-ai',
      };
    },
  };
}
