# FreeCut WanGP Connector

This unpacked Chrome extension lets `https://video.xedoc.ru` use WanGP running
only on the same computer at `http://127.0.0.1:7860`. It does not open WanGP to
the network and it only runs on `video.xedoc.ru`.

## Install

1. Open `chrome://extensions` in Chrome or Edge.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `extensions/wangp-connector` folder.
4. Keep WanGP running on port 7860, then open the **AI** tab in FreeCut and press
   **Check connector**.

The connector opens an inactive WanGP tab to submit the prompt through the
application's own interface. Keep that tab open while a generation is running.
When the task finishes, FreeCut downloads the generated video through the
extension and stores it in the selected project's local workspace.
