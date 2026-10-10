#!/usr/bin/env python3
"""Asset publication gates without initializing or changing any Git repository."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('assets',Path(__file__).with_name('build-nanobot-assets.py'))
m = importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
REV = 'a'*40


class AssetTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.package=self.root/'nanobot-sandbox'
        for name,path in m.FILES.items():
            target=self.package/path;target.parent.mkdir(parents=True,exist_ok=True)
            target.write_text('working tree '+name+'\n')
        self.dirty='';self.origin=m.REPOSITORY;self.top=self.package
        self.remote=REV+'\trefs/tags/v0.1.0\n';self.reads=[]

    def git(self,package,*args,raw=False):
        self.assertEqual(package,self.package.resolve());self.reads.append(args)
        if args==('rev-parse','--show-toplevel'):return str(self.top)
        if args==('rev-parse','HEAD'):return REV
        if args==('status','--porcelain','--untracked-files=all'):return self.dirty
        if args==('remote','get-url','origin'):return self.origin
        if args==('ls-remote','origin'):return self.remote
        if args[0]=='show':
            self.assertTrue(raw);self.assertTrue(args[1].startswith(REV+':'))
            return 'published bytes with trailing space \n\n'
        raise AssertionError(args)

    def test_fixture_explicitly_unpublished_and_does_not_use_git(self):
        with patch.object(m,'git',side_effect=AssertionError('fixture consulted Git')):
            source=m.build(self.root,fixture=True)
        self.assertEqual(source['mode'],'fixture');self.assertIsNone(source['revision'])
        assets=json.loads((self.root/'.nanobot-assets.json').read_text())
        self.assertNotIn('index.mjs',assets)
        for name in m.FILES:
            self.assertEqual(source['sha256'][name],hashlib.sha256(assets[name].encode()).hexdigest())

    def test_published_assets_read_pinned_bytes_not_working_tree(self):
        with patch.object(m,'git',side_effect=self.git):source=m.build(self.root)
        self.assertEqual(source['mode'],'published');self.assertEqual(source['revision'],REV)
        self.assertEqual(source['refs'],['refs/tags/v0.1.0'])
        assets=json.loads((self.root/'.nanobot-assets.json').read_text())
        self.assertEqual(assets['nanobot-mcp.mjs'],'published bytes with trailing space \n\n')

    def test_rejects_parent_repo_fallback_dirty_wrong_origin_and_unpublished(self):
        m.build(self.root,fixture=True)
        prior=(self.root/'.nanobot-assets.json').read_bytes()
        cases=[('top',self.root,'own initialized'),('dirty',' M nanobot-mcp.mjs','dirty'),
               ('origin','https://github.com/someone/other.git','origin'),
               ('remote','b'*40+'\trefs/heads/main\n','not an advertised')]
        for field,value,error in cases:
            old=getattr(self,field);setattr(self,field,value);self.reads=[]
            with self.subTest(field=field),patch.object(m,'git',side_effect=self.git):
                with self.assertRaisesRegex(m.BuildError,error):m.build(self.root)
            self.assertFalse(any(args[0]=='show' for args in self.reads))
            self.assertEqual((self.root/'.nanobot-assets.json').read_bytes(),prior)
            setattr(self,field,old)

    def test_remote_outage_does_not_fall_back_to_fixture(self):
        def unavailable(package,*args,**kwargs):
            if args[0]=='ls-remote':raise m.BuildError('Cannot verify Nanobot Git publication')
            return self.git(package,*args,**kwargs)
        with patch.object(m,'git',side_effect=unavailable):
            with self.assertRaisesRegex(m.BuildError,'Cannot verify'):m.build(self.root)
        self.assertFalse((self.root/'.nanobot-assets.json').exists())


if __name__=='__main__':unittest.main()
