# Wiki to Confluence migration based on NodeJS and Axios

This isn't fanciest code ever, but it does the job in ok-ish way.

Script escapes wiki links and attachments and ask wiki to render wiki content,
then escript renders the links back into xhtml for confluence.

In fact converstion goes like

    wiki -> html -> confluence xhtml

## What is supported

* basic formatting, as long is it is not generaing broken html
* wiki categories, they become confluence tags
* wiki attachments (PDF, JPG, PNG, GIF, XLS, others are not tested)

## What is not supported

* namespaced pages, like user-pages, e.g.: `User:Agent.smith`
* links in secion headers
* image formatting, all images become fixed width previews
* <I assume a lot of other things which were not tested>
