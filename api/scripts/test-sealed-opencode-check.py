"""Offline qualification tests: subprocess is mocked, never invoke inference."""
import json
import subprocess
import unittest
from unittest.mock import patch

from sealed_opencode_check import qualify, verdict

CANARY = "SEALED-GENUINE-CONTROL-OK"


def result(code=0, text="", error=""):
    stdout = json.dumps({"type": "text", "part": {"text": text}}) if text else ""
    return subprocess.CompletedProcess([], code, stdout, error)


class QualificationTests(unittest.TestCase):
    def test_verdicts(self):
        control = result(text=CANARY)
        refused = result(1, error="attestation verification failed: digest mismatch")
        self.assertEqual(verdict(control, refused, CANARY), "PASS")
        for error in ("plugin load failed", "model not found", "Unauthorized", "invalid API key",
                      "fetch failed", "ECONNREFUSED", "unrecognized failure",
                      "attestation verification failed: fetch failed", "attestation verification failed"):
            with self.subTest(error=error):
                self.assertEqual(verdict(control, result(1, error=error), CANARY), "INCONCLUSIVE")
        for bad_control in (result(1), result(), subprocess.CompletedProcess([], 0, CANARY, "")):
            self.assertEqual(verdict(bad_control, refused, CANARY), "INCONCLUSIVE")
        self.assertEqual(verdict(control, result(text=CANARY), CANARY), "FAIL")
        self.assertEqual(verdict(control, result(1, text="unexpected answer"), CANARY), "FAIL")
        self.assertEqual(verdict(control, result(), CANARY), "INCONCLUSIVE")
        self.assertEqual(verdict(control, result(error="plugin load failed"), CANARY), "INCONCLUSIVE")

    def test_same_client_control_then_mutation(self):
        genuine, mutated = {"digest": "genuine"}, {"digest": "mutated"}
        served, calls = {}, []

        def run(command, **kwargs):
            calls.append((command, kwargs, served["bundle"]))
            return result(text=CANARY) if len(calls) == 1 else result(1, error="digest mismatch")

        with patch("sealed_opencode_check.subprocess.run", side_effect=run):
            self.assertEqual(qualify("https://inert.invalid/sealed", "https://localhost:8799", "/inert.pem",
                                     served, genuine, lambda _: mutated), "PASS")
        self.assertEqual(len(calls), 2)
        self.assertIs(calls[0][2], genuine)
        self.assertIs(calls[1][2], mutated)
        self.assertEqual(calls[0][:2], calls[1][:2])
        self.assertIn("--standalone", calls[0][0])
        env = calls[0][1]["env"]
        self.assertEqual(env["HOME"], calls[0][1]["cwd"])
        self.assertNotIn("OPENROUTER_API_KEY", env)
        self.assertIs(served["bundle"], genuine)

    def test_unavailable_control_does_not_run_mutation(self):
        for outcome in (result(1, error="plugin load failed"), FileNotFoundError(), subprocess.TimeoutExpired("inert", 1)):
            served, genuine = {}, {"digest": "genuine"}
            with patch("sealed_opencode_check.subprocess.run", side_effect=[outcome]) as run:
                self.assertEqual(qualify("https://inert.invalid", "https://localhost", "/inert.pem",
                                         served, genuine, lambda _: self.fail("mutation must not run")), "INCONCLUSIVE")
                self.assertEqual(run.call_count, 1)
            self.assertIs(served["bundle"], genuine)


if __name__ == "__main__":
    unittest.main()
