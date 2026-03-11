/**
 * Landing Page Route
 *
 * Unauthenticated: sign-in prompt + description.
 * Authenticated: staff panel (register a course) + published course list.
 */

import { Hono } from 'hono';
import type { AppEnv, CourseRow, MembershipRow } from '../types';
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
          <a href="https://github.com/rndmcnlly/bayleaf">GitHub</a>.
        </p>
      </BaseLayout>,
    );
  }

  // Logged in — fetch data
  const email = session.email;

  // Courses with a pending claim by this user
  const pendingClaims = await c.env.DB.prepare(
    `SELECT * FROM courses WHERE claim_email = ? ORDER BY created_at DESC`
  ).bind(email).all<CourseRow>();

  // Courses where the user is staff (verified)
  const staffCourses = await c.env.DB.prepare(
    `SELECT c.* FROM courses c
     JOIN memberships m ON c.canvas_course_id = m.canvas_course_id
     WHERE m.email = ? AND m.role = 'staff'
     ORDER BY c.created_at DESC`
  ).bind(email).all<CourseRow>();

  // Courses where the user is enrolled (student)
  const enrolledCourses = await c.env.DB.prepare(
    `SELECT c.* FROM courses c
     JOIN memberships m ON c.canvas_course_id = m.canvas_course_id
     WHERE m.email = ? AND m.role = 'user'
     ORDER BY c.name`
  ).bind(email).all<CourseRow>();

  // All published courses (for browse)
  const publishedCourses = await c.env.DB.prepare(
    `SELECT c.*, COUNT(m.email) as user_count FROM courses c
     LEFT JOIN memberships m ON c.canvas_course_id = m.canvas_course_id AND m.role = 'user'
     WHERE c.published = 1
     GROUP BY c.canvas_course_id
     ORDER BY c.name`
  ).all<CourseRow & { user_count: number }>();

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

      {/* Pending claims */}
      {pendingClaims.results.length > 0 && (
        <div>
          <h2>Pending Claims</h2>
          {pendingClaims.results.map((course) => (
            <div class={cardStyle} key={course.canvas_course_id} style="border-color: #e67e22;">
              <h3 style="margin-top: 0;">
                <a href={`/courses/${course.canvas_course_id}`}>{course.name}</a>
              </h3>
              <p style="color: #e67e22; font-size: 0.9rem;">
                Awaiting verification &mdash; <a href={`/courses/${course.canvas_course_id}`}>complete claim</a>
              </p>
            </div>
          ))}
        </div>
      )}

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
                {course.prompt_text.startsWith('CLAIM:') && (
                  <span> &middot; <span style="color: #e67e22;">Claim pending</span></span>
                )}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Enrolled courses */}
      {enrolledCourses.results.length > 0 && (
        <div>
          <h2>Your Installed Models</h2>
          {enrolledCourses.results.map((course) => (
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
      {publishedCourses.results.length === 0 ? (
        <p style="color: #666;">No courses published yet.</p>
      ) : (
        publishedCourses.results.map((course) => {
          const isEnrolled = enrolledCourses.results.some(
            (e) => e.canvas_course_id === course.canvas_course_id
          );
          return (
            <div class={cardStyle} key={course.canvas_course_id}>
              <div style="display: flex; justify-content: space-between; align-items: baseline;">
                <h3 style="margin-top: 0;">
                  <a href={`/courses/${course.canvas_course_id}`}>{course.name}</a>
                </h3>
                <span style="color: #666; font-size: 0.85rem;">
                  {course.user_count} student{course.user_count !== 1 ? 's' : ''}
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
