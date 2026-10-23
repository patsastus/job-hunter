document.addEventListener('DOMContentLoaded', () => {
  const statusText = document.getElementById('status-text');
  const scrapeBtn = document.getElementById('scrape-btn');
  const appendCheckbox = document.getElementById('append-checkbox');
  const uploadBtn = document.getElementById('upload-btn');
  const uploadFile = document.getElementById('upload-file');
  const clearBtn = document.getElementById('clear-btn');
  const savedCount = document.getElementById('saved-count');
  const resultArea = document.getElementById('result-area');

  let currentSavedContent = "";
  let jobsCount = 0;

  // Initialize storage
  chrome.storage.local.get(['savedContent', 'jobsCount'], (result) => {
    if (result.savedContent) {
      currentSavedContent = result.savedContent;
    }
    if (result.jobsCount) {
      jobsCount = result.jobsCount;
      savedCount.textContent = jobsCount;
    }
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    const isDuunitori = tab.url && tab.url.includes('duunitori.fi/tyopaikat/tyo/');
    const isLinkedIn = tab.url && tab.url.includes('linkedin.com/jobs/view/');
    const isLinkedInCollection = tab.url && tab.url.includes('linkedin.com/jobs/collections/') && tab.url.includes('currentJobId=');

    if (isDuunitori || isLinkedIn || isLinkedInCollection) {
      statusText.textContent = 'Ready to scrape this job.';
      statusText.style.backgroundColor = '#d4edda';
      statusText.style.color = '#155724';
      scrapeBtn.disabled = false;
    } else {
      statusText.textContent = 'Not a valid job page.';
      statusText.style.backgroundColor = '#f8d7da';
      statusText.style.color = '#721c24';
    }
  });

  uploadBtn.addEventListener('click', () => {
    uploadFile.click();
  });

  uploadFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      currentSavedContent = event.target.result;
      // Estimate jobs count by counting "## " (assuming job headers)
      const matches = currentSavedContent.match(/^## /gm);
      jobsCount = matches ? matches.length : 0;
      updateStorage();
      resultArea.textContent = 'File uploaded successfully.';
      setTimeout(() => resultArea.textContent = '', 3000);
    };
    reader.readAsText(file);
  });

  clearBtn.addEventListener('click', () => {
    currentSavedContent = "";
    jobsCount = 0;
    updateStorage();
    resultArea.textContent = 'Saved data cleared.';
    setTimeout(() => resultArea.textContent = '', 3000);
  });

  scrapeBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];

      // Check for duplicate before scraping
      if (appendCheckbox.checked && currentSavedContent && currentSavedContent.includes(tab.url)) {
        resultArea.textContent = '⚠️ This job is already saved!';
        resultArea.style.color = '#e0a800';
        setTimeout(() => { resultArea.textContent = ''; resultArea.style.color = '#28a745'; }, 3000);
        return;
      }

      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      }, (injectionResults) => {
        if (chrome.runtime.lastError) {
          resultArea.textContent = 'Error: ' + chrome.runtime.lastError.message;
          return;
        }
        
        const data = injectionResults[0].result;
        if (data) {
          pushJobToAPI(data);
        }
      });
    });
  });

  async function pushJobToAPI(data) {
    try {
      resultArea.textContent = 'Pushing to Job Hunter OS...';
      const response = await fetch('http://jobs.test/api/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data)
      });
      
      if (response.ok) {
        resultArea.textContent = '✅ Job saved to Job Hunter OS!';
        resultArea.style.color = '#28a745';
        jobsCount++;
        savedCount.textContent = jobsCount;
      } else {
        const errorData = await response.json();
        resultArea.textContent = '❌ Failed: ' + (errorData.detail || response.statusText);
        resultArea.style.color = '#721c24';
      }
    } catch (error) {
      resultArea.textContent = '❌ Error: Backend not reachable (Is jobs.test running?)';
      resultArea.style.color = '#721c24';
      console.error(error);
    }
    setTimeout(() => resultArea.textContent = '', 4000);
  }

  function updateStorage() {
    savedCount.textContent = jobsCount;
    chrome.storage.local.set({ savedContent: currentSavedContent, jobsCount: jobsCount });
  }
});
