"""Course-boundary regression checks for the group-readable Brace3 toolkit."""

import unittest

from tool import _is_allowed_canvas_url


class CanvasUrlTest(unittest.TestCase):
    def test_course_content_and_pagination(self):
        for url in (
            "https://canvas.ucsc.edu/api/v1/courses/94741?include[]=syllabus_body",
            "https://canvas.ucsc.edu/api/v1/courses/94741/assignments?page=2&per_page=50",
            "https://canvas.ucsc.edu/api/v1/courses/94741/assignments/897740",
            "https://canvas.ucsc.edu/api/v1/courses/94741/quizzes/1234",
            "https://canvas.ucsc.edu/api/v1/courses/94741/pages/brace3-system-prompt",
        ):
            with self.subTest(url=url):
                self.assertTrue(_is_allowed_canvas_url(url))

    def test_other_courses_and_sensitive_routes(self):
        for url in (
            "https://canvas.ucsc.edu/api/v1/courses/92591/assignments",
            "https://canvas.ucsc.edu/api/v1/courses/94741/assignments/897740/submissions",
            "https://canvas.ucsc.edu/api/v1/courses/94741/assignments?include[]=submission",
            "https://canvas.ucsc.edu/api/v1/courses/94741/pages/%2e%2e%2fassignments",
            "https://canvas.ucsc.edu/api/v1/courses/94741/pages/../users",
            "https://canvas.ucsc.edu/api/v1/courses/94741?page=-1",
            "https://canvas.ucsc.edu/api/v1/courses/94741#fragment",
            "https://canvas.ucsc.edu.evil.example/api/v1/courses/94741",
            "http://canvas.ucsc.edu/api/v1/courses/94741",
        ):
            with self.subTest(url=url):
                self.assertFalse(_is_allowed_canvas_url(url))


if __name__ == "__main__":
    unittest.main()
