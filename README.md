# Spoke

A sidebar inbox for GitHub activity that needs your attention.

- Polls GitHub notifications in the background.
- Stores the inbox in plugin-owned SQLite, so opening the page only reads local data.
- Separates pull request and issue counts in the sidebar.
- Preserves notifications locally after GitHub marks them read.
- Archives notifications locally; newer GitHub activity automatically resurfaces an archived thread.
- Starts a review thread from a pull request notification in the BB project whose GitHub remote matches the repository.
- Uses ETags and GitHub's `X-Poll-Interval` guidance to avoid unnecessary API requests.

## Configure

Open the sidebar page and choose **Connect GitHub**. The plugin uses GitHub's OAuth Device Flow and requests the `notifications` scope. The OAuth App configured in `server.ts` must have **Enable Device Flow** selected in its GitHub settings.

A personal access token can also be entered manually under **Extensions → GitHub Notifications**. For a fine-grained token, grant **Notifications: read**. For a classic token, use the `notifications` scope (and repository access appropriate to the notifications you want to receive).

The polling interval can be set to 60, 120, or 300 seconds. A manual **Refresh** action is also available on the inbox page.

## Develop

```sh
npm install
bb plugin build
bb plugin reload github-notifications
```

The plugin stores its cache and archive state in BB's plugin database at the standard plugin data location. The token is a secret BB setting and is never sent to the frontend or stored in that database.
