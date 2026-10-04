#!/usr/bin/env python3
"""Credential-output regressions for the sandbox-facing preview helper."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error

helper = Path(__file__).resolve().parents[1]/'sandbox-skills/expose-sandbox-ports-technique/scripts/expose.py'
spec = importlib.util.spec_from_file_location('expose', helper)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class HelperTests(unittest.TestCase):
    def test_success_and_failures_do_not_emit_credential_or_provider_body(self):
        secret='sk-bayleaf-synthetic-never-display'
        response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        response.read.return_value=json.dumps({'url':'https://owner-private-abc.bayleaf-proxies.dev/',
            'expires_at':'2026-10-04T00:00:00Z','debug':secret}).encode()
        opener=Mock();opener.open.return_value=response
        with tempfile.TemporaryDirectory() as home, patch.object(m.Path,'home',return_value=Path(home)), \
             patch.dict(m.os.environ,{'BAYLEAF_API_KEY':secret}), patch.object(m.urllib.request,'build_opener',return_value=opener):
            result,code=m.run(8000);self.assertEqual(code,0);self.assertNotIn(secret,json.dumps(result))
            request=opener.open.call_args.args[0]
            self.assertEqual(request.full_url,'https://api.bayleaf.dev/sandbox/expose')
            self.assertEqual(json.loads(request.data)['access'],'private')
            opener.open.side_effect=urllib.error.HTTPError('https://example.invalid/'+secret,403,secret,{},None)
            result,code=m.run(8000);self.assertEqual(code,1);self.assertNotIn(secret,json.dumps(result))
            opener.open.side_effect=RuntimeError(secret)
            result,code=m.run(8000);self.assertEqual(code,1);self.assertNotIn(secret,json.dumps(result))

    def test_accidentally_pasted_key_is_not_echoed_by_argument_errors(self):
        secret='sk-bayleaf-synthetic-never-display'
        result=subprocess.run([sys.executable,str(helper),secret],capture_output=True,text=True)
        self.assertEqual(result.returncode,2);self.assertNotIn(secret,result.stdout+result.stderr)


if __name__=='__main__': unittest.main()
