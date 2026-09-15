const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)(\?|$)/i;

function isImageUrl(url) {
  return IMAGE_EXTENSIONS.test(url);
}

module.exports = { isImageUrl };
