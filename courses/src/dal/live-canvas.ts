/**
 * Live Canvas DAL — real Canvas LMS API calls
 *
 * Uses Adam's personal access token for broad read access.
 */

import type { Bindings } from '../types';
import type { CanvasDAL, CanvasCourseInfo, CanvasPageContent } from './types';
import { CANVAS_API } from '../constants';

export function createLiveCanvasDAL(env: Bindings): CanvasDAL {
  const headers = {
    'Authorization': `Bearer ${env.CANVAS_TOKEN}`,
  };

  return {
    async getCourseInfo(courseId) {
      const res = await fetch(`${CANVAS_API}/courses/${courseId}`, { headers });
      if (!res.ok) {
        console.error(`[canvas-dal] Get course failed: ${res.status}`);
        return null;
      }
      const data = await res.json() as { id: number; name: string; course_code: string };
      return { id: data.id, name: data.name, course_code: data.course_code };
    },

    async getPageByTitle(courseId, titleSlug) {
      const res = await fetch(`${CANVAS_API}/courses/${courseId}/pages/${titleSlug}`, { headers });
      if (!res.ok) {
        if (res.status === 404) return null; // page doesn't exist yet
        console.error(`[canvas-dal] Get page failed: ${res.status}`);
        return null;
      }
      const data = await res.json() as { title: string; body: string; url: string };
      return { title: data.title, body: data.body ?? '', url: data.url };
    },
  };
}
