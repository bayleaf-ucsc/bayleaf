import os
import requests
from typing import *
from datetime import datetime
from pydantic import BaseModel, Field
import aiohttp
from bs4 import BeautifulSoup


class Tools:
    def __init__(self):
        self.base_url = "https://campusdirectory.ucsc.edu"
        self.search_url = f"{self.base_url}/cd_simple"
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
            "DNT": "1",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
        }

    async def __get_csrf_tokens__(
        self, session: aiohttp.ClientSession
    ) -> tuple[str, str]:
        """Get fresh CSRF tokens by visiting the search page"""
        try:
            async with session.get(self.search_url) as response:
                response.raise_for_status()
                html = await response.text()

            soup = BeautifulSoup(html, "html.parser")

            # Find CSRF token inputs
            csrf_name_input = soup.find("input", {"name": "CSRFName"})
            csrf_token_input = soup.find("input", {"name": "CSRFToken"})

            if csrf_name_input and csrf_token_input:
                csrf_name = csrf_name_input.get("value", "")
                csrf_token = csrf_token_input.get("value", "")
                return csrf_name, csrf_token
            else:
                return "", ""
        except Exception as e:
            print(f"Warning: Could not get CSRF tokens: {e}")
            return "", ""

    async def search_campus_directory(
        self, keyword: str, affiliation: str = "All"
    ) -> List[Dict]:
        """
        Search the campus directory (https://campusdirectory.ucsc.edu/).

        Args:
            keyword: Search keyword (name, email, department, etc.)
            affiliation: Type of affiliation (All, Faculty, Staff, Student, etc.)

        Returns:
            List of dictionaries containing person information

        Advice:
            It may be necessary to run multiple searches to account for nicknames or alternate spellings. This whole thing is mostly just an example of integrating with campus systems, so the user might be better off using the directory site directly for critical tasks.
        """
        # Create a fresh session for this search
        async with aiohttp.ClientSession(headers=self.headers) as session:
            try:
                # Get fresh CSRF tokens
                csrf_name, csrf_token = await self.__get_csrf_tokens__(session)

                # Build search parameters
                data = {
                    "Action": "Find",
                    "affiliation": affiliation,
                    "keyword": keyword,
                    "CSRFName": csrf_name,
                    "CSRFToken": csrf_token,
                }

                # Perform the search
                async with session.post(
                    self.search_url,
                    data=data,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    allow_redirects=True,
                ) as response:
                    response.raise_for_status()
                    html = await response.text()

                # Parse the HTML response
                return self.__parse_results__(html)

            except Exception as e:
                print(f"Error searching directory: {e}")
                import traceback

                traceback.print_exc()
                return []

    def __parse_results__(self, html: str) -> List[Dict]:
        """Parse HTML results into structured data"""
        soup = BeautifulSoup(html, "html.parser")
        results = []

        # Find the results table
        table = soup.find("table", {"id": "dresults"})
        if not table:
            return results

        # Extract headers from the table
        headers = []
        header_row = table.find("tr")
        if header_row:
            for th in header_row.find_all("th"):
                header_text = th.get_text(strip=True)
                headers.append(header_text)

        # Parse data rows
        for row in table.find_all("tr")[1:]:  # Skip header row
            cells = row.find_all("td")
            if not cells:
                continue

            # Create a dict by zipping headers with cell values
            person = {}

            for i, (header, cell) in enumerate(zip(headers, cells)):
                # Get text content, stripping whitespace
                text = cell.get_text(strip=True)

                # Skip empty cells
                if not text:
                    continue

                # Add non-empty values to the result
                person[header] = text

            # Extract additional metadata from the first cell (Name column)
            if cells:
                name_cell = cells[0]
                link = name_cell.find("a")
                if link:
                    href = link.get("href", "")

                    # Extract UID from the link
                    if "uid=" in href:
                        person["uid"] = href.split("uid=")[1].split("&")[0]

                    # Add detail URL
                    if href:
                        person["detail_url"] = f"{self.base_url}/{href}"

            # Only add if we have some data
            if person:
                results.append(person)

        return results

    async def get_person_details(self, uid: str) -> Dict:
        """
        Get detailed information for a person by their uid (cruzid, the thing before the @ucsc.edu in their email).

        Args:
            uid: The person's UID (username)

        Returns:
            Dictionary containing detailed person information

        Advice:
            Only run this tool if we can already infer the relevant user's institutional email address.
        """
        detail_url = f"{self.base_url}/cd_detail?uid={uid}"

        async with aiohttp.ClientSession(headers=self.headers) as session:
            try:
                async with session.get(detail_url) as response:
                    response.raise_for_status()
                    html = await response.text()

                # Parse the detail page
                return self.__parse_detail_page__(html, uid)

            except Exception as e:
                print(f"Error fetching person details: {e}")
                import traceback

                traceback.print_exc()
                return {}

    def __parse_detail_page__(self, html: str, uid: str) -> Dict:
        """Parse person detail page into structured data"""
        soup = BeautifulSoup(html, "html.parser")
        person = {"uid": uid}

        # Extract name from h2 tag
        name_tag = soup.find("h2")
        if name_tag:
            # Remove the icon
            icon = name_tag.find("i")
            if icon:
                icon.decompose()
            person["name"] = name_tag.get_text(strip=True)

        # Extract all labeled fields from profileBody
        profile_body = soup.find("div", {"id": "profileBody"})
        if profile_body:
            # Find all divs with label/value pairs
            for div in profile_body.find_all(
                "div", style=lambda value: value and "column-break-inside" in value
            ):
                label_tag = div.find("label")
                if label_tag:
                    label = label_tag.get_text(strip=True)

                    # Get the value (everything after the label)
                    label_tag.decompose()  # Remove label to get just the value

                    # Check for links (like website)
                    links = div.find_all("a")
                    if links:
                        link_values = []
                        for link in links:
                            link_text = link.get_text(strip=True)
                            link_url = link.get("href", "")
                            link_values.append({"text": link_text, "url": link_url})

                        if len(link_values) == 1:
                            person[label] = link_values[0]
                        else:
                            person[label] = link_values
                    else:
                        # Regular text value
                        value = div.get_text(strip=True)
                        if value:  # Only add non-empty values
                            person[label] = value

        # Extract email and phone from profileHead col2
        profile_head = soup.find("div", {"id": "profileHead"})
        if profile_head:
            # Phone
            phone_icon = profile_head.find("i", class_="fa-phone")
            if phone_icon and phone_icon.parent:
                person["phone"] = phone_icon.parent.get_text(strip=True)

            # Email
            email_link = profile_head.find("a", href=lambda x: x and "mailto:" in x)
            if email_link:
                person["email"] = email_link.get_text(strip=True)

        return person
