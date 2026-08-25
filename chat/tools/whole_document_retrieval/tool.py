"""
title: Whole Document Retrieval
author: Adam Smith
author_url: https://adamsmith.as
description: Agentic retrieval from OWUI Knowledge bases — list and read full documents by name rather than relying on vector/embedding search. Useful when "Bypass Embedding and Retrieval" is enabled or when the model needs to reason about which documents to consult before reading them. All operations are gated by the calling user's KB access grants.
required_open_webui_version: 0.9.0
version: 0.5.0
licence: MIT
"""

from typing import Optional
from open_webui.models.knowledge import Knowledges
from open_webui.models.files import Files


async def _check_kb_access(knowledge_base_id: str, user_id: str) -> Optional[str]:
    """
    Returns None if the user has read access to the KB, or an error string if not.
    Admins are always granted access.
    """
    if not await Knowledges.check_access_by_user_id(knowledge_base_id, user_id, permission="read"):
        return f"Access denied: you do not have read access to knowledge base `{knowledge_base_id}`."
    return None


class Tools:
    def __init__(self):
        self.citation = True

    async def list_model_knowledge_bases(
        self,
        __user__: dict = {},
        __model_knowledge__: list = [],
    ) -> str:
        """
        List the Knowledge bases explicitly attached to this model by its
        designer. Returns their IDs, names, descriptions, and document counts.
        Call this first when you need to look up documents — it reflects what
        the model was configured to use.

        If the result is empty, this model was intentionally configured with no
        attached knowledge bases. Do NOT automatically fall back to
        list_all_accessible_knowledge_bases unless the user has explicitly
        asked you to search outside this model's configured knowledge.
        """
        try:
            user_id = __user__.get("id", "")
            role = __user__.get("role", "")

            if not __model_knowledge__:
                return (
                    "This model has no knowledge bases attached. "
                    "If you were expecting documents to be available, the model "
                    "may have been intentionally configured without knowledge — "
                    "do not search elsewhere unless the user explicitly asks."
                )

            lines = []
            for item in __model_knowledge__:
                kb_id = item.get("id")
                if not kb_id:
                    continue
                if role != "admin" and not await Knowledges.check_access_by_user_id(kb_id, user_id, permission="read"):
                    continue
                kb = await Knowledges.get_knowledge_by_id(kb_id)
                if not kb:
                    continue
                files = await Knowledges.get_files_by_id(kb_id) or []
                desc = kb.description or "(no description)"
                lines.append(f"- **{kb.name}** (id: `{kb_id}`, {len(files)} docs): {desc}")

            if not lines:
                return "No accessible knowledge bases are attached to this model."
            return "\n".join(lines)
        except Exception as e:
            return f"Error listing model knowledge bases: {e}"

    async def list_all_accessible_knowledge_bases(self, __user__: dict = {}) -> str:
        """
        List ALL Knowledge bases the current user has read access to across the
        entire deployment. Only call this when the user has explicitly asked to
        search or browse knowledge outside of this model's configured scope —
        prefer list_model_knowledge_bases for normal use.
        """
        try:
            user_id = __user__.get("id", "")
            role = __user__.get("role", "")
            all_kbs = await Knowledges.get_knowledge_bases()
            if not all_kbs:
                return "No knowledge bases found."
            lines = []
            for kb in all_kbs:
                if role == "admin" or await Knowledges.check_access_by_user_id(kb.id, user_id, permission="read"):
                    desc = kb.description or "(no description)"
                    lines.append(f"- **{kb.name}** (id: `{kb.id}`): {desc}")
            if not lines:
                return "No knowledge bases accessible to you."
            return "\n".join(lines)
        except Exception as e:
            return f"Error listing knowledge bases: {e}"

    async def list_documents(self, knowledge_base_id: str, __user__: dict = {}) -> str:
        """
        List all documents in a Knowledge base by ID. Returns document names
        and their file IDs. Use this to discover what documents are available
        before calling read_document.

        :param knowledge_base_id: The UUID of the knowledge base to list.
        """
        try:
            user_id = __user__.get("id", "")
            role = __user__.get("role", "")
            if role != "admin":
                err = await _check_kb_access(knowledge_base_id, user_id)
                if err:
                    return err
            files = await Knowledges.get_files_by_id(knowledge_base_id)
            if not files:
                return f"No documents found in knowledge base `{knowledge_base_id}`."
            lines = []
            for f in files:
                name = (f.meta or {}).get("name") or f.filename
                lines.append(f"- `{name}` (file_id: `{f.id}`)")
            return f"Documents in knowledge base `{knowledge_base_id}`:\n" + "\n".join(lines)
        except Exception as e:
            return f"Error listing documents: {e}"

    async def read_document(self, file_id: str, __user__: dict = {}) -> str:
        """
        Read the full text content of a document by its file ID. Returns the
        complete document text for the model to reason over. Prefer this over
        vector search when you need the full policy text or when embeddings are
        bypassed.

        :param file_id: The file UUID returned by list_documents.
        """
        try:
            user_id = __user__.get("id", "")
            role = __user__.get("role", "")

            file = await Files.get_file_by_id(file_id)
            if not file:
                return f"Document `{file_id}` not found."

            # Verify the user has read access to at least one KB containing this file
            if role != "admin":
                kbs = await Knowledges.get_knowledges_by_file_id(file_id)
                accessible = False
                for kb in (kbs or []):
                    if await Knowledges.check_access_by_user_id(kb.id, user_id, permission="read"):
                        accessible = True
                        break
                if not accessible:
                    return f"Access denied: you do not have read access to document `{file_id}`."

            name = (file.meta or {}).get("name") or file.filename
            content = (file.data or {}).get("content") or ""
            if not content:
                return f"Document `{name}` exists but has no extracted text content."
            return f"# {name}\n\n{content}"
        except Exception as e:
            return f"Error reading document: {e}"

    async def search_documents(
        self,
        knowledge_base_id: str,
        query: str,
        full_text: bool = False,
        __user__: dict = {},
    ) -> str:
        """
        Search documents within a Knowledge base for those likely relevant to a
        query.

        By default (full_text=False), matches only against filenames and
        descriptions — fast, but will miss topic mentions that don't appear in
        the filename. File descriptions are often empty, making this effectively
        a filename-only search.

        With full_text=True, matches against the complete extracted text of each
        document — finds any topic regardless of filename, but reads all
        documents into memory and is much slower. Use it when the filename-only
        search returns nothing and you need to locate which document covers a
        topic.

        Returns matching document names and file IDs for use with read_document.

        :param knowledge_base_id: The UUID of the knowledge base to search.
        :param query: Keywords to search for.
        :param full_text: If True, search document content instead of just filenames.
        """
        try:
            user_id = __user__.get("id", "")
            role = __user__.get("role", "")
            if role != "admin":
                err = await _check_kb_access(knowledge_base_id, user_id)
                if err:
                    return err

            files = await Knowledges.get_files_by_id(knowledge_base_id)
            if not files:
                return f"No documents found in knowledge base `{knowledge_base_id}`."

            q = query.lower()
            words = q.split()
            matches = []

            for f in files:
                name = (f.meta or {}).get("name") or f.filename
                if full_text:
                    # Fetch full content via Files table
                    full_file = await Files.get_file_by_id(f.id)
                    content = ((full_file.data or {}).get("content") or "") if full_file else ""
                    haystack = (name + " " + content).lower()
                else:
                    desc = (f.meta or {}).get("description") or ""
                    haystack = (name + " " + desc).lower()

                if any(word in haystack for word in words):
                    matches.append(f"- `{name}` (file_id: `{f.id}`)")

            mode = "full-text" if full_text else "filename"
            if not matches:
                return (
                    f"No documents in `{knowledge_base_id}` matched {query!r} "
                    f"({mode} search)."
                    + ("" if full_text else " Try full_text=True to search document contents.")
                )
            return f"Matching documents for {query!r} ({mode} search):\n" + "\n".join(matches)
        except Exception as e:
            return f"Error searching documents: {e}"
