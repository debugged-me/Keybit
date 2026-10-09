// Simulates a single-page app login: no form submission, the script swaps the view and the URL.
document.querySelector("#go").addEventListener("click", () => setTimeout(() => {
  history.pushState(null, "", "/dashboard");
  document.querySelector("#app").innerHTML = "<h1>Dashboard</h1><p>Signed in.</p>";
}, 50));
