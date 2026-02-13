const express = require('express')
const compression = require('compression')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 4173

const clientDistPath = path.join(__dirname, '..', 'client', 'dist')

app.use(compression())
app.use(express.static(clientDistPath))

app.get('*', (req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'))
})

app.listen(PORT, () => {
  console.log(`Strata server running at http://localhost:${PORT}`)
})
