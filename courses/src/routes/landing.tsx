/**
 * Landing Page Route
 *
 * Unauthenticated: sign-in prompt + description.
 * Authenticated: staff panel (register a course) + published course list.
 */

import { Hono } from 'hono';
import type { AppEnv, CourseRow } from '../types';
import { BaseLayout, btnStyle, cardStyle } from '../templates/layout';
import { getSession } from '../utils/session';

export const landingRoutes = new Hono<AppEnv>();

/**
 * GET / - Landing page
 */
landingRoutes.get('/', async (c) => {
  const session = await getSession(c);

  if (!session) {
    return c.html(
      <BaseLayout title="Home">
        <p>
          Self-service course AI models for the UC Santa Cruz community.
          Instructors connect their Canvas courses to{' '}
          <a href="https://chat.bayleaf.dev">BayLeaf Chat</a>, and students
          install custom course models with one click.
        </p>
        <div class={cardStyle}>
          <p>Sign in with your UCSC Google account to get started.</p>
          <a href="/login" class={btnStyle}>Sign in with Google</a>
        </div>
        <p style="font-size: 0.9rem; color: #666;">
          Follow development on{' '}
          <a href="https://github.com/bayleaf-ucsc/bayleaf">GitHub</a>.
        </p>
      </BaseLayout>,
    );
  }

  // Logged in — fetch data
  const email = session.email;

  // Staff courses from D1 (staff membership is still authoritative in D1)
  const staffCourses = await c.env.DB.prepare(
    `SELECT c.* FROM courses c
     JOIN memberships m ON c.canvas_course_id = m.canvas_course_id
     WHERE m.email = ? AND m.role = 'staff'
     ORDER BY c.created_at DESC`
  ).bind(email).all<CourseRow>();

  // Published courses from D1
  const publishedRows = await c.env.DB.prepare(
    `SELECT * FROM courses WHERE published = 1 ORDER BY name`
  ).all<CourseRow>();

  // Student enrollment comes from OWUI (source of truth).
  // One call to list all course models, one call to resolve current user.
  const owuiUser = await c.var.chatDAL.searchUserByEmail(email);
  const courseModels = await c.var.chatDAL.listCourseModels();

  // Build lookup: course ID → { studentCount, isEnrolled }
  const enrollmentInfo = new Map<number, { studentCount: number; isEnrolled: boolean }>();
  for (const model of courseModels) {
    const idMatch = model.id.match(/^course-(\d+)$/);
    if (!idMatch) continue;
    const cid = parseInt(idMatch[1], 10);
    const staffUserIds = new Set(
      model.access_grants.filter((g) => g.permission === 'write').map((g) => g.principal_id)
    );
    const readGrants = model.access_grants.filter(
      (g) => g.principal_type === 'user' && g.permission === 'read' && !staffUserIds.has(g.principal_id)
    );
    enrollmentInfo.set(cid, {
      studentCount: readGrants.length,
      isEnrolled: owuiUser ? readGrants.some((g) => g.principal_id === owuiUser.id) : false,
    });
  }

  // Derive enrolled courses list from OWUI data + D1 course names
  const enrolledCourseIds = new Set(
    [...enrollmentInfo.entries()].filter(([, info]) => info.isEnrolled).map(([cid]) => cid)
  );
  const enrolledCourses = publishedRows.results.filter(
    (c) => enrolledCourseIds.has(c.canvas_course_id)
  );

  return c.html(
    <BaseLayout title="Home">
      <p style="margin-bottom: 0.5rem;">
        Signed in as <strong>{session.name}</strong> ({email})
        <a href="/logout" style="margin-left: 1rem; font-size: 0.9rem;">Sign out</a>
      </p>

      {/* Staff Panel */}
      <div class={cardStyle}>
        <h2 style="margin-top: 0;">Register a Course</h2>
        <p>Paste your Canvas course URL to create a BayLeaf AI model for your class.</p>
        <form method="post" action="/courses" style="display: flex; gap: 0.5rem; align-items: start; flex-wrap: wrap;">
          <input
            type="url"
            name="canvas_url"
            placeholder="https://canvas.ucsc.edu/courses/..."
            required
            style="flex: 1; min-width: 250px; padding: 0.6rem; border: 1px solid #ccc; border-radius: 4px; font-size: 1rem;"
          />
          <button type="submit" class={btnStyle}>Register</button>
        </form>
      </div>

      {/* Staff courses */}
      {staffCourses.results.length > 0 && (
        <div>
          <h2>Your Staff Courses</h2>
          {staffCourses.results.map((course) => (
            <div class={cardStyle} key={course.canvas_course_id}>
              <h3 style="margin-top: 0;">
                <a href={`/courses/${course.canvas_course_id}`}>{course.name}</a>
              </h3>
              <p style="color: #666; font-size: 0.9rem;">
                {course.published
                  ? <span style="color: #28a745;">Published</span>
                  : <span style="color: #dc3545;">Not published</span>}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Enrolled courses */}
      {enrolledCourses.length > 0 && (
        <div>
          <h2>Your Installed Models</h2>
          {enrolledCourses.map((course) => (
            <div class={cardStyle} key={course.canvas_course_id}>
              <h3 style="margin-top: 0;">
                <a href={`/courses/${course.canvas_course_id}`}>{course.name}</a>
              </h3>
              <a href={`${c.env.OWUI_BASE_URL}/?model=course-${course.canvas_course_id}`} target="_blank" style="font-size: 0.9rem;">
                Open in BayLeaf Chat
              </a>
            </div>
          ))}
        </div>
      )}

      {/* Published courses browse */}
      <h2>All Published Courses</h2>
      {publishedRows.results.length === 0 ? (
        <p style="color: #666;">No courses published yet.</p>
      ) : (
        publishedRows.results.map((course) => {
          const info = enrollmentInfo.get(course.canvas_course_id);
          const studentCount = info?.studentCount ?? 0;
          const isEnrolled = info?.isEnrolled ?? false;
          return (
            <div class={cardStyle} key={course.canvas_course_id}>
              <div style="display: flex; justify-content: space-between; align-items: baseline;">
                <h3 style="margin-top: 0;">
                  <a href={`/courses/${course.canvas_course_id}`}>{course.name}</a>
                </h3>
                <span style="color: #666; font-size: 0.85rem;">
                  {studentCount} student{studentCount !== 1 ? 's' : ''}
                </span>
              </div>
              {isEnrolled ? (
                <span style="color: #28a745; font-size: 0.9rem;">Installed</span>
              ) : (
                <form method="post" action={`/courses/${course.canvas_course_id}/join`} style="display: inline;">
                  <button type="submit" class={btnStyle} style="padding: 0.4rem 1rem; font-size: 0.9rem;">Install</button>
                </form>
              )}
            </div>
          );
        })
      )}
    </BaseLayout>,
  );
});
