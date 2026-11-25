import unittest

from function import Filter


def resolved(*names, prefix="builtin:"):
    return {name: {"tool_id": prefix + name} for name in names}


def body(*names):
    return {"tools": [{"type": "function", "function": {"name": name}} for name in names]}


class AuthoringBlockTest(unittest.TestCase):
    def test_removes_authoring_and_keeps_skill_reading(self):
        tools = resolved("view_skill", "create_skill", "create_tool")
        out = Filter().request(body(*tools), {"tools": tools})
        self.assertEqual([t["function"]["name"] for t in out["tools"]], ["view_skill"])
        self.assertEqual(list(tools), ["view_skill"])

    def test_toolkit_method_with_same_name_survives(self):
        tools = resolved("create_skill", prefix="some_toolkit:")
        out = Filter().request(body("create_skill"), {"tools": tools})
        self.assertEqual(len(out["tools"]), 1)
        self.assertIn("create_skill", tools)

    def test_empty_list_dropped_and_missing_metadata_tolerated(self):
        out = Filter().request(body("create_tool"), {"tools": resolved("create_tool")})
        self.assertNotIn("tools", out)
        self.assertEqual(Filter().request({"messages": []}), {"messages": []})


if __name__ == "__main__":
    unittest.main()
