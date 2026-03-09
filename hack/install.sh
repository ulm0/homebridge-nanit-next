npm install --prefix /homebridge --ignore-scripts homebridge-nanit-1.3.11.tgz && \
node -e " \
        const fs = require(\"fs\"); \
        const pkg = JSON.parse(fs.readFileSync(\"/homebridge/package.json\",\"utf8\")); \
        const ver = require(\"/homebridge/node_modules/homebridge-nanit/package.json\").version; \
        pkg.dependencies[\"homebridge-nanit\"] = ver; \
        fs.writeFileSync(\"/homebridge/package.json\", JSON.stringify(pkg, null, 2)); \
"